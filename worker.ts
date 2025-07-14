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

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await executeHangupTasks(env, ctx);
  }
};

async function handleApiRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (url.pathname === '/api/hangup/auth' && request.method === 'POST') {
      const body = await request.json() as { userId: string };
      const userToken = await generateUserToken(body.userId);
      const userAuth: UserAuth = {
        userId: body.userId,
        userToken,
        createdAt: new Date().toISOString()
      };
      
      await env.KV_BINDING.put(`auth:${body.userId}`, JSON.stringify(userAuth));
      
      return new Response(JSON.stringify({ 
        success: true, 
        userId: body.userId, 
        userToken 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/hangup/configs' && request.method === 'POST') {
      const body = await request.json() as UserConfig;
      
      if (!await validateUserToken(body.userId, body.userToken, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const configId = await generateConfigId();
      const executionOffset = Math.floor(Math.random() * 300); // 0-300秒随机偏移
      
      const config: UserConfig = {
        ...body,
        configId,
        executionOffset,
        isActive: true,
        createdAt: new Date().toISOString()
      };

      await env.KV_BINDING.put(`stv_config:${body.userId}:${configId}`, JSON.stringify(config));
      
      return new Response(JSON.stringify({ 
        success: true, 
        configId,
        message: '配置保存成功' 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/hangup/configs' && request.method === 'GET') {
      const userId = url.searchParams.get('userId');
      const userToken = url.searchParams.get('userToken');
      
      if (!userId || !userToken || !await validateUserToken(userId, userToken, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const configs = await getUserConfigs(userId, env);
      return new Response(JSON.stringify({ configs }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname.startsWith('/api/hangup/configs/') && request.method === 'DELETE') {
      const configId = url.pathname.split('/').pop();
      const body = await request.json() as { userId: string; userToken: string };
      
      if (!await validateUserToken(body.userId, body.userToken, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      await env.KV_BINDING.delete(`stv_config:${body.userId}:${configId}`);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { 
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal Server Error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function serveHangupPage(env: Env): Promise<Response> {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>STV 自动挂机管理</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .container { background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input, textarea { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        button { background: #007cba; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #005a8b; }
        .config-item { background: white; padding: 15px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007cba; }
        .status { padding: 5px 10px; border-radius: 3px; font-size: 12px; }
        .status.active { background: #d4edda; color: #155724; }
        .status.inactive { background: #f8d7da; color: #721c24; }
        .error { color: #d32f2f; margin-top: 10px; }
        .success { color: #388e3c; margin-top: 10px; }
    </style>
</head>
<body>
    <h1>STV 自动挂机管理</h1>
    
    <div class="container">
        <h2>用户验证</h2>
        <div class="form-group">
            <label for="userId">用户ID:</label>
            <input type="text" id="userId" placeholder="请输入你的 STV 用户ID">
        </div>
        <button onclick="authenticateUser()">验证用户</button>
        <div id="authMessage"></div>
    </div>

    <div id="configSection" style="display: none;">
        <div class="container">
            <h2>添加新配置</h2>
            <form id="configForm">
                <div class="form-group">
                    <label for="configName">配置名称:</label>
                    <input type="text" id="configName" placeholder="例如：主号、小号1 等" required>
                </div>
                <div class="form-group">
                    <label for="stvUID">STV 用户ID:</label>
                    <input type="text" id="stvUID" placeholder="你的 STV 用户ID" required>
                </div>
                <div class="form-group">
                    <label for="cookie">Cookie:</label>
                    <textarea id="cookie" rows="4" placeholder="粘贴完整的 Cookie 内容" required></textarea>
                </div>
                <button type="submit">保存配置</button>
            </form>
            <div id="configMessage"></div>
        </div>

        <div class="container">
            <h2>我的配置</h2>
            <button onclick="loadConfigs()">刷新配置列表</button>
            <div id="configsList"></div>
        </div>
    </div>

    <script>
        let currentUser = null;

        async function authenticateUser() {
            const userId = document.getElementById('userId').value.trim();
            if (!userId) {
                showMessage('authMessage', '请输入用户ID', 'error');
                return;
            }

            try {
                const response = await fetch('/api/hangup/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    currentUser = { userId: result.userId, userToken: result.userToken };
                    document.getElementById('configSection').style.display = 'block';
                    showMessage('authMessage', '验证成功！', 'success');
                    loadConfigs();
                } else {
                    showMessage('authMessage', '验证失败', 'error');
                }
            } catch (error) {
                console.error('Auth error:', error);
                showMessage('authMessage', '验证过程中发生错误', 'error');
            }
        }

        // 修复表单提交事件处理
        document.addEventListener('DOMContentLoaded', function() {
            const configForm = document.getElementById('configForm');
            if (configForm) {
                configForm.addEventListener('submit', async function(event) {
                    event.preventDefault(); // 防止默认表单提交
                    
                    if (!currentUser) {
                        showMessage('configMessage', '请先验证用户', 'error');
                        return;
                    }

                    const formData = {
                        userId: currentUser.userId,
                        userToken: currentUser.userToken,
                        configName: document.getElementById('configName').value.trim(),
                        stvUID: document.getElementById('stvUID').value.trim(),
                        cookie: document.getElementById('cookie').value.trim()
                    };

                    if (!formData.configName || !formData.stvUID || !formData.cookie) {
                        showMessage('configMessage', '请填写所有字段', 'error');
                        return;
                    }

                    try {
                        const response = await fetch('/api/hangup/configs', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(formData)
                        });
                        
                        const result = await response.json();
                        
                        if (result.success) {
                            showMessage('configMessage', '配置保存成功！', 'success');
                            configForm.reset(); // 重置表单
                            loadConfigs(); // 刷新配置列表
                        } else {
                            showMessage('configMessage', '保存失败: ' + (result.error || '未知错误'), 'error');
                        }
                    } catch (error) {
                        console.error('Save error:', error);
                        showMessage('configMessage', '保存过程中发生错误', 'error');
                    }
                });
            }
        });

        async function loadConfigs() {
            if (!currentUser) return;

            try {
                const response = await fetch(\`/api/hangup/configs?userId=\${currentUser.userId}&userToken=\${currentUser.userToken}\`);
                const result = await response.json();
                
                if (result.configs) {
                    displayConfigs(result.configs);
                }
            } catch (error) {
                console.error('Load configs error:', error);
            }
        }

        function displayConfigs(configs) {
            const container = document.getElementById('configsList');
            if (configs.length === 0) {
                container.innerHTML = '<p>暂无配置</p>';
                return;
            }

            container.innerHTML = configs.map(config => \`
                <div class="config-item">
                    <h3>\${config.configName}</h3>
                    <p><strong>STV UID:</strong> \${config.stvUID}</p>
                    <p><strong>状态:</strong> <span class="status \${config.isActive ? 'active' : 'inactive'}">\${config.isActive ? '运行中' : '已停止'}</span></p>
                    <p><strong>上次执行:</strong> \${config.lastExecuted || '未执行'}</p>
                    <p><strong>执行结果:</strong> \${config.lastResult || '无'}</p>
                    <button onclick="deleteConfig('\${config.configId}')" style="background: #dc3545;">删除配置</button>
                </div>
            \`).join('');
        }

        async function deleteConfig(configId) {
            if (!confirm('确定要删除这个配置吗？')) return;

            try {
                const response = await fetch(\`/api/hangup/configs/\${configId}\`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: currentUser.userId, userToken: currentUser.userToken })
                });
                
                const result = await response.json();
                if (result.success) {
                    loadConfigs();
                }
            } catch (error) {
                console.error('Delete error:', error);
            }
        }

        function showMessage(elementId, message, type) {
            const element = document.getElementById(elementId);
            element.textContent = message;
            element.className = type;
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
}

async function executeHangupTasks(env: Env, ctx: ExecutionContext) {
  try {
    const currentTime = new Date();
    const currentSecond = currentTime.getSeconds() + currentTime.getMinutes() * 60;
    
    const allKeys = await env.KV_BINDING.list({ prefix: 'stv_config:' });
    
    for (const key of allKeys.keys) {
      try {
        const configData = await env.KV_BINDING.get(key.name);
        if (!configData) continue;
        
        const config: UserConfig = JSON.parse(configData);
        if (!config.isActive) continue;
        
        const offset = config.executionOffset || 0;
        const targetSecond = offset % 300;
        
        if (Math.abs(currentSecond - targetSecond) <= 30) {
          ctx.waitUntil(executeHangupRequest(config, env));
        }
      } catch (error) {
        console.error(\`Error processing config \${key.name}:\`, error);
      }
    }
  } catch (error) {
    console.error('Error in executeHangupTasks:', error);
  }
}

async function executeHangupRequest(config: UserConfig, env: Env) {
  try {
    const response = await fetch(\`https://sangtacviet.app/io/user/online?ngmar=ol2&u=\${config.stvUID}\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': config.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: 'sajax=online&ngmar=ol'
    });

    const result = await response.text();
    const success = response.ok && result.includes('success');
    
    config.lastExecuted = new Date().toISOString();
    config.lastResult = success ? '成功' : \`失败: \${result.substring(0, 100)}\`;
    
    await env.KV_BINDING.put(\`stv_config:\${config.userId}:\${config.configId}\`, JSON.stringify(config));
    
  } catch (error) {
    config.lastExecuted = new Date().toISOString();
    config.lastResult = \`错误: \${error instanceof Error ? error.message : 'Unknown error'}\`;
    await env.KV_BINDING.put(\`stv_config:\${config.userId}:\${config.configId}\`, JSON.stringify(config));
  }
}

async function validateUserToken(userId: string, userToken: string, env: Env): Promise<boolean> {
  try {
    const authData = await env.KV_BINDING.get(\`auth:\${userId}\`);
    if (!authData) return false;
    
    const auth: UserAuth = JSON.parse(authData);
    return auth.userToken === userToken;
  } catch {
    return false;
  }
}

async function getUserConfigs(userId: string, env: Env): Promise<UserConfig[]> {
  const configs: UserConfig[] = [];
  const allKeys = await env.KV_BINDING.list({ prefix: \`stv_config:\${userId}:\` });
  
  for (const key of allKeys.keys) {
    try {
      const configData = await env.KV_BINDING.get(key.name);
      if (configData) {
        const config: UserConfig = JSON.parse(configData);
        // 不返回敏感信息
        delete (config as any).cookie;
        delete (config as any).userToken;
        configs.push(config);
      }
    } catch (error) {
      console.error(\`Error loading config \${key.name}:\`, error);
    }
  }
  
  return configs;
}

async function generateUserToken(userId: string): Promise<string> {
  const timestamp = Date.now().toString();
  const randomStr = Math.random().toString(36).substring(2, 15);
  const tokenData = \`\${userId}_\${timestamp}_\${randomStr}\`;
  
  const encoder = new TextEncoder();
  const data = encoder.encode(tokenData);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return btoa(tokenData + '_' + hashHex.substring(0, 10));
}

async function generateConfigId(): Promise<string> {
  return 'cfg_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 15);
}