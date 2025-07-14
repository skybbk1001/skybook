// worker.ts
interface Env {
  ASSETS: Fetcher;
  KV_BINDING: KVNamespace;
}

interface UserConfig {
  userId: string;
  stvUID: string;
  cookie: string;
  isActive: boolean;
  lastExecuted?: string;
  lastResult?: string;
  createdAt: string;
  userToken: string; // 用户身份验证令牌
}

interface UserAuth {
  userId: string;
  userToken: string;
  createdAt: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // API 路由处理
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, url, env);
    }
    
    // 挂机管理页面
    if (url.pathname === '/hangup' || url.pathname === '/hangup/') {
      return serveHangupPage(env);
    }
    
    // 静态资源处理
    return env.ASSETS.fetch(request);
  },

  // Cron 触发器处理 - 每5分钟执行
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await executeHangupTasks(env);
  }
};

// 生成用户令牌
function generateUserToken(userId: string): string {
  const timestamp = Date.now().toString();
  const randomStr = Math.random().toString(36).substring(2);
  return btoa(`${userId}_${timestamp}_${randomStr}`);
}

// 验证用户身份
async function verifyUserAuth(userId: string, userToken: string, env: Env): Promise<boolean> {
  if (!userId || !userToken) return false;
  
  const authKey = `auth:${userId}`;
  const authData = await env.KV_BINDING.get(authKey);
  
  if (!authData) return false;
  
  const auth: UserAuth = JSON.parse(authData);
  return auth.userToken === userToken;
}

// 创建或获取用户身份验证
async function createOrGetUserAuth(userId: string, env: Env): Promise<string> {
  const authKey = `auth:${userId}`;
  const existingAuth = await env.KV_BINDING.get(authKey);
  
  if (existingAuth) {
    const auth: UserAuth = JSON.parse(existingAuth);
    return auth.userToken;
  }
  
  // 创建新的用户身份验证
  const userToken = generateUserToken(userId);
  const auth: UserAuth = {
    userId,
    userToken,
    createdAt: new Date().toISOString()
  };
  
  await env.KV_BINDING.put(authKey, JSON.stringify(auth));
  return userToken;
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

  try {
    switch (path) {
      case '/api/hangup/login':
        if (request.method === 'POST') {
          return await loginUser(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/config':
        if (request.method === 'POST') {
          return await saveUserConfig(request, env, corsHeaders);
        } else if (request.method === 'GET') {
          return await getUserConfig(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/toggle':
        if (request.method === 'POST') {
          return await toggleHangup(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/delete':
        if (request.method === 'DELETE') {
          return await deleteUserConfig(request, env, corsHeaders);
        }
        break;

      case '/api/hangup/test':
        if (request.method === 'POST') {
          return await testHangupRequest(request, env, corsHeaders);
        }
        break;
    }

    return new Response('API endpoint not found', { 
      status: 404, 
      headers: corsHeaders 
    });

  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 用户登录/获取令牌
async function loginUser(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const { userId } = await request.json();

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
}

// 从请求中获取用户身份信息
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
      if (body.userId && body.userToken) {
        authData = { userId: body.userId, userToken: body.userToken };
      }
    }
    
    return authData || null;
  } catch {
    return null;
  }
}

// 保存用户配置
async function saveUserConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
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
  const { stvUID, cookie } = body;

  if (!stvUID || !cookie) {
    return new Response(JSON.stringify({ error: '缺少必要参数：STV UID 和 Cookie' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const config: UserConfig = {
    userId: authData.userId,
    stvUID: stvUID.trim(),
    cookie: cookie.trim(),
    isActive: true,
    userToken: authData.userToken,
    createdAt: new Date().toISOString()
  };

  const key = `stv_config:${authData.userId}`;
  await env.KV_BINDING.put(key, JSON.stringify(config));

  return new Response(JSON.stringify({ 
    success: true, 
    message: `用户 ${authData.userId} 的挂机配置保存成功，将保持 STV UID ${stvUID} 在线状态` 
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// 获取用户配置
async function getUserConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
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

  const key = `stv_config:${authData.userId}`;
  const configData = await env.KV_BINDING.get(key);
  
  if (!configData) {
    return new Response(JSON.stringify({ error: '用户配置不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const config: UserConfig = JSON.parse(configData);
  
  // 只返回当前用户的配置（不包含敏感信息）
  return new Response(JSON.stringify({
    userId: config.userId,
    stvUID: config.stvUID,
    isActive: config.isActive,
    lastExecuted: config.lastExecuted,
    lastResult: config.lastResult,
    createdAt: config.createdAt,
    cookieExists: !!config.cookie
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// 切换挂机状态
async function toggleHangup(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
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

  const { isActive } = await request.clone().json();

  const key = `stv_config:${authData.userId}`;
  const configData = await env.KV_BINDING.get(key);
  
  if (!configData) {
    return new Response(JSON.stringify({ error: '用户配置不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const config: UserConfig = JSON.parse(configData);
  config.isActive = isActive;

  await env.KV_BINDING.put(key, JSON.stringify(config));

  return new Response(JSON.stringify({ 
    success: true, 
    message: isActive ? `用户 ${authData.userId} 挂机已启动` : `用户 ${authData.userId} 挂机已停止` 
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// 删除用户配置
async function deleteUserConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
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

  const configKey = `stv_config:${authData.userId}`;
  const authKey = `auth:${authData.userId}`;
  
  await env.KV_BINDING.delete(configKey);
  await env.KV_BINDING.delete(authKey);

  return new Response(JSON.stringify({ 
    success: true, 
    message: `用户 ${authData.userId} 的配置已删除` 
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// 测试挂机请求
async function testHangupRequest(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
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

  const key = `stv_config:${authData.userId}`;
  const configData = await env.KV_BINDING.get(key);
  
  if (!configData) {
    return new Response(JSON.stringify({ error: '用户配置不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const config: UserConfig = JSON.parse(configData);
  
  try {
    const result = await executeSTVOnlineRequest(config);
    return new Response(JSON.stringify({ 
      success: true, 
      message: '测试请求成功', 
      result: result
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: '测试请求失败', 
      error: error.message 
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// 执行所有挂机任务
async function executeHangupTasks(env: Env): Promise<void> {
  console.log('开始执行 STV 在线保持任务...');
  
  try {
    const { keys } = await env.KV_BINDING.list({ prefix: 'stv_config:' });
    
    let activeCount = 0;
    let successCount = 0;
    
    for (const key of keys) {
      const configData = await env.KV_BINDING.get(key.name);
      if (configData) {
        const config: UserConfig = JSON.parse(configData);
        
        if (config.isActive) {
          activeCount++;
          try {
            const result = await executeSTVOnlineRequest(config);
            successCount++;
            
            // 更新最后执行时间和结果
            config.lastExecuted = new Date().toISOString();
            config.lastResult = `成功: ${result}`;
            await env.KV_BINDING.put(key.name, JSON.stringify(config));
            
            console.log(`用户 ${config.userId} (STV UID: ${config.stvUID}) 在线保持成功`);
            
          } catch (error) {
            console.error(`用户 ${config.userId} 在线保持失败:`, error);
            
            // 更新失败结果
            config.lastExecuted = new Date().toISOString();
            config.lastResult = `失败: ${error.message}`;
            await env.KV_BINDING.put(key.name, JSON.stringify(config));
          }
        }
      }
    }
    
    console.log(`STV 在线保持任务完成: ${successCount}/${activeCount} 成功`);
    
  } catch (error) {
    console.error('执行 STV 在线保持任务时出错:', error);
  }
}

// 为单个用户执行 STV 在线请求
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

// 提供挂机管理页面
function serveHangupPage(env: Env): Response {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>STV 在线保持系统</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            max-width: 900px; 
            margin: 0 auto; 
            padding: 20px; 
            background: #f5f5f5;
        }
        .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .login-container { max-width: 400px; margin: 50px auto; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; }
        input, textarea { 
            width: 100%; 
            padding: 12px; 
            border: 1px solid #ddd; 
            border-radius: 6px; 
            font-size: 14px;
            box-sizing: border-box;
        }
        textarea { resize: vertical; min-height: 80px; }
        button { 
            background: #007cba; 
            color: white; 
            padding: 12px 24px; 
            border: none; 
            border-radius: 6px; 
            cursor: pointer; 
            font-size: 14px;
            margin-right: 10px;
            margin-bottom: 10px;
        }
        button:hover { background: #005a87; }
        button.danger { background: #dc3545; }
        button.danger:hover { background: #c82333; }
        button.success { background: #28a745; }
        button.success:hover { background: #218838; }
        .status { padding: 15px; margin: 15px 0; border-radius: 6px; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
        .config-item { 
            border: 1px solid #ddd; 
            padding: 20px; 
            margin: 15px 0; 
            border-radius: 6px; 
            background: #fafafa;
        }
        .config-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .config-title { font-size: 18px; font-weight: 600; color: #333; }
        .status-badge { 
            padding: 4px 12px; 
            border-radius: 20px; 
            font-size: 12px; 
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-active { background: #d4edda; color: #155724; }
        .status-inactive { background: #f8d7da; color: #721c24; }
        .help-text { font-size: 12px; color: #666; margin-top: 5px; }
        h1 { color: #333; text-align: center; margin-bottom: 30px; }
        .hidden { display: none; }
        .user-info { background: #e7f3ff; padding: 10px; border-radius: 6px; margin-bottom: 20px; }
        .logout-btn { background: #6c757d; }
        .logout-btn:hover { background: #545b62; }
    </style>
</head>
<body>
    <!-- 登录界面 -->
    <div id="login-page" class="login-container">
        <div class="container">
            <h1>STV 在线保持系统</h1>
            <div class="status info">
                <strong>用户隔离说明：</strong>每个用户只能查看和管理自己的配置，数据完全隔离。
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

    <!-- 主界面 -->
    <div id="main-page" class="container hidden">
        <div class="config-header">
            <h1>STV 在线保持系统</h1>
            <button class="logout-btn" onclick="logout()">退出登录</button>
        </div>
        
        <div class="user-info">
            <strong>当前用户：</strong><span id="currentUser"></span>
        </div>
        
        <div class="status info">
            <strong>说明：</strong>本系统每5分钟自动向 sangtacviet.app 发送在线保持请求，防止账号离线。
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
        <button onclick="testRequest()">测试连接</button>
        <button onclick="loadConfig()">刷新状态</button>
        
        <div id="status"></div>
        <div id="configDisplay"></div>
    </div>

    <script>
        let currentUserId = '';
        let currentUserToken = '';
        
        // 页面加载时检查是否已登录
        document.addEventListener('DOMContentLoaded', () => {
            const savedUserId = localStorage.getItem('stvUserId');
            const savedUserToken = localStorage.getItem('stvUserToken');
            
            if (savedUserId && savedUserToken) {
                currentUserId = savedUserId;
                currentUserToken = savedUserToken;
                showMainPage();
                loadConfig();
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
                    
                    // 保存到本地存储
                    localStorage.setItem('stvUserId', userId);
                    localStorage.setItem('stvUserToken', result.userToken);
                    
                    showLoginStatus(result.message, 'success');
                    setTimeout(() => {
                        showMainPage();
                        loadConfig();
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
                stvUID: document.getElementById('stvUID').value.trim(),
                cookie: document.getElementById('cookie').value.trim()
            };
            
            if (!data.stvUID || !data.cookie) {
                showStatus('请填写完整信息', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/hangup/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                showStatus(result.message || result.error, response.ok ? 'success' : 'error');
                
                if (response.ok) {
                    loadConfig();
                }
            } catch (error) {
                showStatus('保存失败: ' + error.message, 'error');
            }
        }
        
        async function testRequest() {
            if (!currentUserId || !currentUserToken) {
                showStatus('请先登录', 'error');
                return;
            }
            
            showStatus('正在测试连接...', 'info');
            
            try {
                const response = await fetch('/api/hangup/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        userId: currentUserId, 
                        userToken: currentUserToken 
                    })
                });
                
                const result = await response.json();
                showStatus(result.message + (result.result ? ' - 响应: ' + result.result.substring(0, 100) + '...' : ''), 
                          result.success ? 'success' : 'error');
            } catch (error) {
                showStatus('测试失败: ' + error.message, 'error');
            }
        }
        
        async function loadConfig() {
            if (!currentUserId || !currentUserToken) {
                showStatus('请先登录', 'error');
                return;
            }
            
            try {
                const response = await fetch(\`/api/hangup/config?userId=\${encodeURIComponent(currentUserId)}&userToken=\${encodeURIComponent(currentUserToken)}\`);
                const config = await response.json();
                
                if (response.ok) {
                    displayConfig(config);
                } else if (response.status === 404) {
                    document.getElementById('configDisplay').innerHTML = '<div class="status info">暂无配置，请先保存配置</div>';
                } else {
                    showStatus(config.error, 'error');
                }
            } catch (error) {
                showStatus('加载失败: ' + error.message, 'error');
            }
        }
        
        async function toggleHangup(isActive) {
            try {
                const response = await fetch('/api/hangup/toggle', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        userId: currentUserId, 
                        userToken: currentUserToken, 
                        isActive 
                    })
                });
                
                const result = await response.json();
                showStatus(result.message, response.ok ? 'success' : 'error');
                
                if (response.ok) {
                    loadConfig();
                }
            } catch (error) {
                showStatus('操作失败: ' + error.message, 'error');
            }
        }
        
        async function deleteConfig() {
            if (!confirm('确定要删除这个配置吗？')) {
                return;
            }
            
            try {
                const response = await fetch('/api/hangup/delete', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        userId: currentUserId, 
                        userToken: currentUserToken 
                    })
                });
                
                const result = await response.json();
                showStatus(result.message, response.ok ? 'success' : 'error');
                
                if (response.ok) {
                    document.getElementById('configDisplay').innerHTML = '';
                    logout(); // 删除配置后退出登录
                }
            } catch (error) {
                showStatus('删除失败: ' + error.message, 'error');
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
        
        function displayConfig(config) {
            const display = document.getElementById('configDisplay');
            const statusClass = config.isActive ? 'status-active' : 'status-inactive';
            const statusText = config.isActive ? '运行中' : '已停止';
            
            display.innerHTML = \`
                <div class="config-item">
                    <div class="config-header">
                        <div class="config-title">我的配置</div>
                        <div class="status-badge \${statusClass}">\${statusText}</div>
                    </div>
                    <p><strong>用户ID:</strong> \${config.userId}</p>
                    <p><strong>STV UID:</strong> \${config.stvUID}</p>
                    <p><strong>Cookie状态:</strong> \${config.cookieExists ? '已配置' : '未配置'}</p>
                    <p><strong>最后执行:</strong> \${config.lastExecuted ? new Date(config.lastExecuted).toLocaleString() : '从未执行'}</p>
                    <p><strong>执行结果:</strong> \${config.lastResult || '无'}</p>
                    <p><strong>创建时间:</strong> \${new Date(config.createdAt).toLocaleString()}</p>
                    
                    <button class="\${config.isActive ? 'danger' : 'success'}" onclick="toggleHangup(\${!config.isActive})">
                        \${config.isActive ? '停止挂机' : '启动挂机'}
                    </button>
                    <button class="danger" onclick="deleteConfig()">删除配置</button>
                </div>
            \`;
        }
    </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}