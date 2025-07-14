// worker.ts
interface Env {
  ASSETS: Fetcher;
  KV_BINDING: KVNamespace;
}

interface UserConfig {
  configId: string;
  userId: string;
  configName: string;
  stvUID: string;
  cookie: string;
  isActive: boolean;
  lastExecuted?: string;
  lastResult?: string;
  createdAt: string;
  userToken: string;
  executionOffset?: number;
}

interface UserAuth {
  userId: string;
  userToken: string;
  createdAt: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, url, env);
    }
    
    if (url.pathname === '/hangup' || url.pathname === '/hangup/') {
      return serveHangupPage(env);
    }
    
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await executeHangupTasks(env);
  }
};

// 生成配置ID
function generateConfigId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// 生成用户令牌
function generateUserToken(userId: string): string {
  const timestamp = Date.now().toString();
  const randomStr = Math.random().toString(36).substring(2);
  return btoa(`${userId}_${timestamp}_${randomStr}`);
}

// 生成执行偏移量
function generateExecutionOffset(): number {
  return Math.floor(Math.random() * 60);
}

// 验证用户身份
async function verifyUserAuth(userId: string, userToken: string, env: Env): Promise<boolean> {
  try {
    if (!userId || !userToken) {
      console.log('验证失败: 缺少用户ID或令牌');
      return false;
    }
    
    const authKey = `auth:${userId}`;
    const authData = await env.KV_BINDING.get(authKey);
    
    if (!authData) {
      console.log(`验证失败: 未找到用户 ${userId} 的认证信息`);
      return false;
    }
    
    const auth: UserAuth = JSON.parse(authData);
    const isValid = auth.userToken === userToken;
    console.log(`用户 ${userId} 验证结果: ${isValid}`);
    return isValid;
  } catch (error) {
    console.error('验证用户身份时出错:', error);
    return false;
  }
}

// 创建或获取用户身份验证
async function createOrGetUserAuth(userId: string, env: Env): Promise<string> {
  try {
    const authKey = `auth:${userId}`;
    const existingAuth = await env.KV_BINDING.get(authKey);
    
    if (existingAuth) {
      const auth: UserAuth = JSON.parse(existingAuth);
      console.log(`用户 ${userId} 使用现有令牌`);
      return auth.userToken;
    }
    
    const userToken = generateUserToken(userId);
    const auth: UserAuth = {
      userId,
      userToken,
      createdAt: new Date().toISOString()
    };
    
    await env.KV_BINDING.put(authKey, JSON.stringify(auth));
    console.log(`用户 ${userId} 创建新令牌`);
    return userToken;
  } catch (error) {
    console.error('创建或获取用户认证时出错:', error);
    throw error;
  }
}

// 处理 API 请求
async function handleApiRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const path = url.pathname;
  console.log(`API 请求: ${request.method} ${path}`);

  try {
    switch (path) {
      case '/api/hangup/login':
        if (request.method === 'POST') {
          return await loginUser(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/configs':
        if (request.method === 'POST') {
          return await saveUserConfig(request, env, corsHeaders);
        } else if (request.method === 'GET') {
          return await getUserConfigs(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/config/toggle':
        if (request.method === 'POST') {
          return await toggleConfig(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/config/delete':
        if (request.method === 'DELETE') {
          return await deleteConfig(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/config/test':
        if (request.method === 'POST') {
          return await testConfig(request, env, corsHeaders);
        }
        break;
    }

    return new Response('API endpoint not found', { 
      status: 404, 
      headers: corsHeaders 
    });

  } catch (error) {
    console.error('API 处理错误:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal Server Error', 
      details: error.message,
      stack: error.stack 
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 用户登录
async function loginUser(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const body = await request.json();
    console.log('登录请求体:', body);
    
    const { userId } = body;

    if (!userId || userId.trim().length < 3) {
      return new Response(JSON.stringify({ error: '用户ID必须至少3个字符' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const userToken = await createOrGetUserAuth(userId.trim(), env);

    return new Response(JSON.stringify({ 
      success: true, 
      userToken,
      message: '登录成功' 
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    console.error('登录处理错误:', error);
    return new Response(JSON.stringify({ 
      error: '登录失败', 
      details: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 获取用户身份信息
async function getUserFromRequest(request: Request): Promise<{ userId: string, userToken: string } | null> {
  try {
    let authData;
    
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');
      const userToken = url.searchParams.get('userToken');
      if (userId && userToken) {
        authData = { userId, userToken };
      }
    } else {
      const body = await request.json();
      console.log('请求体数据:', body);
      if (body.userId && body.userToken) {
        authData = { userId: body.userId, userToken: body.userToken };
      }
    }
    
    console.log('解析的认证数据:', authData);
    return authData || null;
  } catch (error) {
    console.error('获取用户信息时出错:', error);
    return null;
  }
}

// 保存用户配置
async function saveUserConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    console.log('开始保存用户配置');
    
    // 先克隆请求，因为我们需要多次读取body
    const requestClone = request.clone();
    
    const authData = await getUserFromRequest(requestClone);
    console.log('获取到的认证数据:', authData);
    
    if (!authData) {
      return new Response(JSON.stringify({ error: '缺少身份验证信息' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    console.log('开始验证用户身份');
    const isValid = await verifyUserAuth(authData.userId, authData.userToken, env);
    if (!isValid) {
      return new Response(JSON.stringify({ error: '身份验证失败' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const body = await request.json();
    console.log('配置数据:', { 
      configName: body.configName, 
      stvUID: body.stvUID, 
      cookieLength: body.cookie ? body.cookie.length : 0 
    });
    
    const { configName, stvUID, cookie } = body;

    if (!configName || !stvUID || !cookie) {
      return new Response(JSON.stringify({ error: '缺少必要参数：配置名称、STV UID 和 Cookie' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const configId = generateConfigId();
    const executionOffset = generateExecutionOffset();
    
    console.log(`生成配置ID: ${configId}, 执行偏移量: ${executionOffset}`);
    
    const config: UserConfig = {
      configId,
      userId: authData.userId,
      configName: configName.trim(),
      stvUID: stvUID.trim(),
      cookie: cookie.trim(),
      isActive: true,
      userToken: authData.userToken,
      executionOffset: executionOffset,
      createdAt: new Date().toISOString()
    };

    const key = `stv_config:${authData.userId}:${configId}`;
    console.log(`保存到 KV，键: ${key}`);
    
    await env.KV_BINDING.put(key, JSON.stringify(config));
    console.log('配置保存成功');

    return new Response(JSON.stringify({ 
      success: true, 
      configId,
      message: `配置 "${configName}" 保存成功，将在每个5分钟周期的第 ${executionOffset} 秒执行` 
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
    
  } catch (error) {
    console.error('保存配置时出错:', error);
    return new Response(JSON.stringify({ 
      error: '保存配置失败', 
      details: error.message,
      stack: error.stack 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 获取用户所有配置
async function getUserConfigs(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const authData = await getUserFromRequest(request);
    if (!authData) {
      return new Response(JSON.stringify({ error: '缺少身份验证信息' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const isValid = await verifyUserAuth(authData.userId, authData.userToken, env);
    if (!isValid) {
      return new Response(JSON.stringify({ error: '身份验证失败' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const { keys } = await env.KV_BINDING.list({ prefix: `stv_config:${authData.userId}:` });
    
    const configs = [];
    for (const key of keys) {
      const configData = await env.KV_BINDING.get(key.name);
      if (configData) {
        const config: UserConfig = JSON.parse(configData);
        configs.push({
          configId: config.configId,
          configName: config.configName,
          stvUID: config.stvUID,
          isActive: config.isActive,
          lastExecuted: config.lastExecuted,
          lastResult: config.lastResult,
          executionOffset: config.executionOffset,
          createdAt: config.createdAt,
          cookieExists: !!config.cookie
        });
      }
    }

    return new Response(JSON.stringify({ configs }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    console.error('获取配置时出错:', error);
    return new Response(JSON.stringify({ 
      error: '获取配置失败', 
      details: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 切换配置状态
async function toggleConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const authData = await getUserFromRequest(request);
    if (!authData) {
      return new Response(JSON.stringify({ error: '缺少身份验证信息' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const isValid = await verifyUserAuth(authData.userId, authData.userToken, env);
    if (!isValid) {
      return new Response(JSON.stringify({ error: '身份验证失败' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const body = await request.clone().json();
    const { configId, isActive } = body;

    const key = `stv_config:${authData.userId}:${configId}`;
    const configData = await env.KV_BINDING.get(key);
    
    if (!configData) {
      return new Response(JSON.stringify({ error: '配置不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const config: UserConfig = JSON.parse(configData);
    config.isActive = isActive;

    await env.KV_BINDING.put(key, JSON.stringify(config));

    return new Response(JSON.stringify({ 
      success: true, 
      message: `配置 "${config.configName}" ${isActive ? '已启动' : '已停止'}` 
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    console.error('切换配置时出错:', error);
    return new Response(JSON.stringify({ 
      error: '切换配置失败', 
      details: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 删除配置
async function deleteConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const authData = await getUserFromRequest(request);
    if (!authData) {
      return new Response(JSON.stringify({ error: '缺少身份验证信息' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const isValid = await verifyUserAuth(authData.userId, authData.userToken, env);
    if (!isValid) {
      return new Response(JSON.stringify({ error: '身份验证失败' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const body = await request.clone().json();
    const { configId } = body;

    const key = `stv_config:${authData.userId}:${configId}`;
    const configData = await env.KV_BINDING.get(key);
    
    if (!configData) {
      return new Response(JSON.stringify({ error: '配置不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const config: UserConfig = JSON.parse(configData);
    await env.KV_BINDING.delete(key);

    return new Response(JSON.stringify({ 
      success: true, 
      message: `配置 "${config.configName}" 已删除` 
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    console.error('删除配置时出错:', error);
    return new Response(JSON.stringify({ 
      error: '删除配置失败', 
      details: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 测试配置
async function testConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const authData = await getUserFromRequest(request);
    if (!authData) {
      return new Response(JSON.stringify({ error: '缺少身份验证信息' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const isValid = await verifyUserAuth(authData.userId, authData.userToken, env);
    if (!isValid) {
      return new Response(JSON.stringify({ error: '身份验证失败' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const body = await request.clone().json();
    const { configId } = body;

    const key = `stv_config:${authData.userId}:${configId}`;
    const configData = await env.KV_BINDING.get(key);
    
    if (!configData) {
      return new Response(JSON.stringify({ error: '配置不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const config: UserConfig = JSON.parse(configData);
    
    const result = await executeSTVOnlineRequest(config);
    return new Response(JSON.stringify({ 
      success: true, 
      message: '测试请求成功', 
      result: result
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    console.error('测试配置时出错:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      message: '测试请求失败', 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 执行所有挂机任务
async function executeHangupTasks(env: Env): Promise<void> {
  const currentTime = new Date();
  const currentSeconds = currentTime.getSeconds();
  
  console.log(`检查 STV 在线保持任务 - 当前时间: ${currentTime.toISOString()}, 秒数: ${currentSeconds}`);
  
  try {
    const { keys } = await env.KV_BINDING.list({ prefix: 'stv_config:' });
    
    let checkedCount = 0;
    let scheduledCount = 0;
    let executedCount = 0;
    let successCount = 0;
    
    for (const key of keys) {
      const configData = await env.KV_BINDING.get(key.name);
      if (configData) {
        const config: UserConfig = JSON.parse(configData);
        
        if (config.isActive) {
          checkedCount++;
          
          const shouldExecuteByTime = shouldExecuteNow(config.lastExecuted);
          
          if (shouldExecuteByTime) {
            scheduledCount++;
            
            const shouldExecuteNow = currentSeconds === (config.executionOffset || 0);
            
            if (shouldExecuteNow) {
              executedCount++;
              try {
                const result = await executeSTVOnlineRequest(config);
                successCount++;
                
                config.lastExecuted = currentTime.toISOString();
                config.lastResult = `成功: ${result.substring(0, 100)}`;
                await env.KV_BINDING.put(key.name, JSON.stringify(config));
                
                console.log(`用户 ${config.userId} 配置 "${config.configName}" (STV UID: ${config.stvUID}) 在线保持成功`);
                
              } catch (error) {
                console.error(`用户 ${config.userId} 配置 "${config.configName}" 在线保持失败:`, error);
                
                config.lastExecuted = currentTime.toISOString();
                config.lastResult = `失败: ${error.message}`;
                await env.KV_BINDING.put(key.name, JSON.stringify(config));
              }
            }
          }
        }
      }
    }
    
    if (executedCount > 0 || scheduledCount > 0) {
      console.log(`STV 任务检查完成: 检查 ${checkedCount} 个活跃配置，${scheduledCount} 个待执行，实际执行 ${executedCount} 个，成功 ${successCount} 个`);
    }
    
  } catch (error) {
    console.error('执行 STV 在线保持任务时出错:', error);
  }
}

// 判断是否应该执行请求
function shouldExecuteNow(lastExecuted: string | undefined): boolean {
  if (!lastExecuted) return true;
  
  const lastTime = new Date(lastExecuted);
  const currentTime = new Date();
  const diffMinutes = (currentTime.getTime() - lastTime.getTime()) / (1000 * 60);
  
  return diffMinutes >= 5;
}

// 执行 STV 在线请求
async function executeSTVOnlineRequest(config: UserConfig): Promise<string> {
  const url = 'https://sangtacviet.app/io/user/online';
  
  const params = new URLSearchParams({
    ngmar: 'ol2',
    u: config.stvUID
  });
  
  const body = new URLSearchParams({
    sajax: 'online',
    ngmar: 'ol'
  });

  const response = await fetch(`${url}?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Cookie': config.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://sangtacviet.app/',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const responseText = await response.text();
  
  if (responseText.includes('Bạn chưa đăng nhập')) {
    throw new Error('Cookie 已失效，请重新登录获取新的 Cookie');
  }
  
  return responseText;
}

// 提供挂机管理页面 (保持不变)
function serveHangupPage(env: Env): Response {
  // ... 页面HTML代码保持不变 ...
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>STV 在线保持系统</title>
    <style>
        /* 样式保持不变 */
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
        .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .login-container { max-width: 400px; margin: 50px auto; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; }
        input, textarea { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
        textarea { resize: vertical; min-height: 80px; }
        button { background: #007cba; color: white; padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; margin-right: 10px; margin-bottom: 10px; }
        button:hover { background: #005a87; }
        button.danger { background: #dc3545; }
        button.danger:hover { background: #c82333; }
        button.success { background: #28a745; }
        button.success:hover { background: #218838; }
        button.small { padding: 6px 12px; font-size: 12px; }
        .status { padding: 15px; margin: 15px 0; border-radius: 6px; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
        .config-item { border: 1px solid #ddd; padding: 20px; margin: 15px 0; border-radius: 6px; background: #fafafa; }
        .config-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .config-title { font-size: 18px; font-weight: 600; color: #333; }
        .status-badge { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
        .status-active { background: #d4edda; color: #155724; }
        .status-inactive { background: #f8d7da; color: #721c24; }
        .help-text { font-size: 12px; color: #666; margin-top: 5px; }
        h1 { color: #333; text-align: center; margin-bottom: 30px; }
        .hidden { display: none; }
        .user-info { background: #e7f3ff; padding: 10px; border-radius: 6px; margin-bottom: 20px; }
        .logout-btn { background: #6c757d; }
        .logout-btn:hover { background: #545b62; }
        .tabs { display: flex; margin-bottom: 20px; border-bottom: 1px solid #ddd; }
        .tab { padding: 12px 24px; cursor: pointer; border-bottom: 2px solid transparent; }
        .tab.active { border-bottom-color: #007cba; color: #007cba; font-weight: 600; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .config-actions { margin-top: 15px; }
        .config-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; }
        .config-meta p { margin: 5px 0; }
        .add-config-btn { background: #28a745; margin-bottom: 20px; }
        .add-config-btn:hover { background: #218838; }
        .offset-info { background: #fff3cd; color: #856404; padding: 8px; border-radius: 4px; font-size: 12px; margin-top: 5px; }
    </style>
</head>
<body>
    <div id="login-page" class="login-container">
        <div class="container">
            <h1>STV 在线保持系统</h1>
            <div class="status info">
                <strong>智能分散请求：</strong>
                <ul>
                    <li>固定5分钟间隔执行在线保持</li>
                    <li>每个配置随机分配执行时机，避免集中请求</li>
                    <li>支持多个配置，数据完全隔离</li>
                </ul>
            </div>
            
            <div class="form-group">
                <label for="loginUserId">用户ID:</label>
                <input type="text" id="loginUserId" placeholder="请输入你的用户ID（至少3个字符）">
                <div class="help-text">这将作为你的唯一标识，请记住此ID</div>
            </div>
            
            <button onclick="login()">登录/注册</button>
            <div id="loginStatus"></div>
        </div>
    </div>

    <div id="main-page" class="container hidden">
        <div class="config-header">
            <h1>STV 在线保持系统</h1>
            <button class="logout-btn" onclick="logout()">退出登录</button>
        </div>
        
        <div class="user-info">
            <strong>当前用户：</strong><span id="currentUser"></span>
        </div>
        
        <div class="tabs">
            <div class="tab active" onclick="switchTab('configs')">我的配置</div>
            <div class="tab" onclick="switchTab('add')">添加配置</div>
        </div>
        
        <div id="configs-tab" class="tab-content active">
            <button class="add-config-btn" onclick="switchTab('add')">+ 添加新配置</button>
            <div id="configsList"></div>
        </div>
        
        <div id="add-tab" class="tab-content">
            <div class="status info">
                <strong>说明：</strong>系统每5分钟自动发送在线保持请求，每个配置会在不同时机执行以避免集中请求。
            </div>
            
            <div class="form-group">
                <label for="configName">配置名称:</label>
                <input type="text" id="configName" placeholder="请输入配置名称，例如：主账号、小号1">
                <div class="help-text">给配置起个名字，方便区分多个账号</div>
            </div>
            
            <div class="form-group">
                <label for="stvUID">STV UID:</label>
                <input type="text" id="stvUID" placeholder="请输入你的 STV UID">
                <div class="help-text">在 sangtacviet.app 个人资料页面可以找到你的 UID</div>
            </div>
            
            <div class="form-group">
                <label for="cookie">Cookie:</label>
                <textarea id="cookie" placeholder="请粘贴从浏览器复制的完整 Cookie"></textarea>
                <div class="help-text">
                    获取方法：F12 开发者工具 → Network → 刷新页面 → 点击任意请求 → Request Headers → 复制 Cookie 值
                </div>
            </div>
            
            <button onclick="saveConfig()">保存配置</button>
            <button onclick="switchTab('configs')">返回配置列表</button>
        </div>
        
        <div id="status"></div>
    </div>

    <script>
        let currentUserId = '';
        let currentUserToken = '';
        
        document.addEventListener('DOMContentLoaded', () => {
            const savedUserId = localStorage.getItem('stvUserId');
            const savedUserToken = localStorage.getItem('stvUserToken');
            
            if (savedUserId && savedUserToken) {
                currentUserId = savedUserId;
                currentUserToken = savedUserToken;
                showMainPage();
                loadConfigs();
            } else {
                showLoginPage();
            }
        });
        
        function showLoginPage() {
            document.getElementById('login-page').classList.remove('hidden');
            document.getElementById('main-page').classList.add('hidden');
        }
        
        function showMainPage() {
            document.getElementById('login-page').classList.add('hidden');
            document.getElementById('main-page').classList.remove('hidden');
            document.getElementById('currentUser').textContent = currentUserId;
        }
        
        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName + '-tab').classList.add('active');
            event.target.classList.add('active');
            
            if (tabName === 'configs') {
                loadConfigs();
            } else if (tabName === 'add') {
                clearAddForm();
            }
        }
        
        function clearAddForm() {
            document.getElementById('configName').value = '';
            document.getElementById('stvUID').value = '';
            document.getElementById('cookie').value = '';
        }
        
        async function login() {
            const userId = document.getElementById('loginUserId').value.trim();
            
            if (!userId || userId.length < 3) {
                showLoginStatus('用户ID必须至少3个字符', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/hangup/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    currentUserId = userId;
                    currentUserToken = result.userToken;
                    
                    localStorage.setItem('stvUserId', userId);
                    localStorage.setItem('stvUserToken', result.userToken);
                    
                    showLoginStatus(result.message, 'success');
                    setTimeout(() => {
                        showMainPage();
                        loadConfigs();
                    }, 1000);
                } else {
                    showLoginStatus(result.error, 'error');
                }
            } catch (error) {
                showLoginStatus('登录失败: ' + error.message, 'error');
            }
        }
        
        function logout() {
            currentUserId = '';
            currentUserToken = '';
            localStorage.removeItem('stvUserId');
            localStorage.removeItem('stvUserToken');
            showLoginPage();
            document.getElementById('loginUserId').value = '';
        }
        
        function showLoginStatus(message, type) {
            const statusDiv = document.getElementById('loginStatus');
            statusDiv.innerHTML = \`<div class="status \${type}">\${message}</div>\`;
        }
        
        async function saveConfig() {
            const data = {
                userId: currentUserId,
                userToken: currentUserToken,
                configName: document.getElementById('configName').value.trim(),
                stvUID: document.getElementById('stvUID').value.trim(),
                cookie: document.getElementById('cookie').value.trim()
            };
            
            if (!data.configName || !data.stvUID || !data.cookie) {
                showStatus('请填写完整信息', 'error');
                return;
            }
            
            try {
                console.log('发送保存请求，数据:', { ...data, cookie: data.cookie.substring(0, 50) + '...' });
                
                const response = await fetch('/api/hangup/configs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                console.log('保存响应:', result);
                
                showStatus(result.message || result.error || JSON.stringify(result), response.ok ? 'success' : 'error');
                
                if (response.ok) {
                    clearAddForm();
                    switchTab('configs');
                }
            } catch (error) {
                console.error('保存配置错误:', error);
                showStatus('保存失败: ' + error.message, 'error');
            }
        }
        
        async function loadConfigs() {
            try {
                const response = await fetch(\`/api/hangup/configs?userId=\${encodeURIComponent(currentUserId)}&userToken=\${encodeURIComponent(currentUserToken)}\`);
                const data = await response.json();
                
                if (response.ok) {
                    displayConfigs(data.configs);
                } else {
                    showStatus(data.error, 'error');
                }
            } catch (error) {
                showStatus('加载配置失败: ' + error.message, 'error');
            }
        }
        
        async function toggleConfig(configId, isActive, configName) {
            try {
                const response = await fetch('/api/hangup/config/toggle', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        userId: currentUserId, 
                        userToken: currentUserToken,
                        configId,
                        isActive 
                    })
                });
                
                const result = await response.json();
                showStatus(result.message, response.ok ? 'success' : 'error');
                
                if (response.ok) {
                    loadConfigs();
                }
            } catch (error) {
                showStatus('操作失败: ' + error.message, 'error');
            }
        }
        
        async function deleteConfig(configId, configName) {
            if (!confirm(\`确定要删除配置 "\${configName}" 吗？\`)) {
                return;
            }
            
            try {
                const response = await fetch('/api/hangup/config/delete', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        userId: currentUserId, 
                        userToken: currentUserToken,
                        configId
                    })
                });
                
                const result = await response.json();
                showStatus(result.message, response.ok ? 'success' : 'error');
                
                if (response.ok) {
                    loadConfigs();
                }
            } catch (error) {
                showStatus('删除失败: ' + error.message, 'error');
            }
        }
        
        async function testConfig(configId, configName) {
            showStatus(\`正在测试配置 "\${configName}"...\`, 'info');
            
            try {
                const response = await fetch('/api/hangup/config/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        userId: currentUserId, 
                        userToken: currentUserToken,
                        configId
                    })
                });
                
                const result = await response.json();
                showStatus(\`配置 "\${configName}" \${result.message}\`, result.success ? 'success' : 'error');
                
                if (response.ok) {
                    loadConfigs();
                }
            } catch (error) {
                showStatus('测试失败: ' + error.message, 'error');
            }
        }
        
        function showStatus(message, type) {
            const statusDiv = document.getElementById('status');
            statusDiv.innerHTML = \`<div class="status \${type}">\${message}</div>\`;
            
            if (type === 'success') {
                setTimeout(() => {
                    statusDiv.innerHTML = '';
                }, 5000);
            }
        }
        
        function displayConfigs(configs) {
            const display = document.getElementById('configsList');
            
            if (configs.length === 0) {
                display.innerHTML = '<div class="status info">暂无配置，点击"添加新配置"开始使用</div>';
                return;
            }
            
            let html = '';
            configs.forEach(config => {
                const statusClass = config.isActive ? 'status-active' : 'status-inactive';
                const statusText = config.isActive ? '运行中' : '已停止';
                
                html += \`
                    <div class="config-item">
                        <div class="config-header">
                            <div class="config-title">\${config.configName}</div>
                            <div class="status-badge \${statusClass}">\${statusText}</div>
                        </div>
                        
                        <div class="config-meta">
                            <p><strong>STV UID:</strong> \${config.stvUID}</p>
                            <p><strong>执行间隔:</strong> 5分钟</p>
                            <p><strong>最后执行:</strong> \${config.lastExecuted ? new Date(config.lastExecuted).toLocaleString() : '从未执行'}</p>
                            <p><strong>创建时间:</strong> \${new Date(config.createdAt).toLocaleString()}</p>
                        </div>
                        
                        <div class="offset-info">
                            执行时机：每个5分钟周期的第 \${config.executionOffset || 0} 秒（避免集中请求）
                        </div>
                        
                        <p><strong>执行结果:</strong> \${config.lastResult || '无'}</p>
                        
                        <div class="config-actions">
                            <button class="\${config.isActive ? 'danger' : 'success'} small" onclick="toggleConfig('\${config.configId}', \${!config.isActive}, '\${config.configName}')">
                                \${config.isActive ? '停止' : '启动'}
                            </button>
                            <button class="small" onclick="testConfig('\${config.configId}', '\${config.configName}')">测试</button>
                            <button class="danger small" onclick="deleteConfig('\${config.configId}', '\${config.configName}')">删除</button>
                        </div>
                    </div>
                \`;
            });
            
            display.innerHTML = html;
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}