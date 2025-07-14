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
  executionCount?: number;
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
    console.log('=== Cron 定时执行开始 ===', new Date().toISOString());
    await executeAllHangupTasks(env, ctx);
    console.log('=== Cron 定时执行结束 ===');
  }
};

async function handleApiRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 手动触发执行
    if (url.pathname === '/api/hangup/execute' && request.method === 'POST') {
      console.log('=== 手动执行开始 ===');
      await executeAllHangupTasks(env, {} as ExecutionContext);
      return new Response(JSON.stringify({ success: true, message: '手动执行完成' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 保存新配置
    if (url.pathname === '/api/hangup/configs' && request.method === 'POST') {
      const body = await request.json() as UserConfig;
      
      const configId = generateConfigId();
      
      const config: UserConfig = {
        ...body,
        configId,
        isActive: true,
        createdAt: new Date().toISOString(),
        executionCount: 0
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

    // 获取用户配置列表
    if (url.pathname === '/api/hangup/configs' && request.method === 'GET') {
      const userId = url.searchParams.get('userId');
      
      if (!userId) {
        return new Response(JSON.stringify({ error: '缺少用户ID' }), { 
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const configs = await getUserConfigs(userId, env);
      return new Response(JSON.stringify({ configs }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 删除配置
    if (url.pathname.startsWith('/api/hangup/configs/') && request.method === 'DELETE') {
      const configId = url.pathname.split('/').pop();
      const body = await request.json() as { userId: string };
      
      await env.KV_BINDING.delete(`stv_config:${body.userId}:${configId}`);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 切换配置状态
    if (url.pathname.startsWith('/api/hangup/configs/') && url.pathname.endsWith('/toggle') && request.method === 'POST') {
      const pathParts = url.pathname.split('/');
      const configId = pathParts[pathParts.length - 2];
      const body = await request.json() as { userId: string };
      
      const configKey = `stv_config:${body.userId}:${configId}`;
      const configData = await env.KV_BINDING.get(configKey);
      
      if (configData) {
        const config: UserConfig = JSON.parse(configData);
        config.isActive = !config.isActive;
        
        await env.KV_BINDING.put(configKey, JSON.stringify(config));
        
        return new Response(JSON.stringify({ success: true, isActive: config.isActive }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({ error: '配置不存在' }), { 
        status: 404,
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
        button { background: #007cba; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px; margin-bottom: 10px; }
        button:hover { background: #005a8b; }
        button.danger { background: #dc3545; }
        button.danger:hover { background: #c82333; }
        button.success { background: #28a745; }
        button.success:hover { background: #218838; }
        button.warning { background: #ffc107; color: #212529; }
        button.warning:hover { background: #e0a800; }
        .config-item { background: white; padding: 15px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007cba; }
        .status { padding: 5px 10px; border-radius: 3px; font-size: 12px; }
        .status.active { background: #d4edda; color: #155724; }
        .status.inactive { background: #f8d7da; color: #721c24; }
        .error { color: #d32f2f; margin-top: 10px; }
        .success { color: #388e3c; margin-top: 10px; }
        .hidden { display: none; }
        .note { background: #e3f2fd; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #2196f3; }
    </style>
</head>
<body>
    <h1>STV 自动挂机管理</h1>
    
    <div class="note">
        <p><strong>说明：</strong>系统每5分钟自动执行一次所有启用的配置，无需手动干预。</p>
    </div>
    
    <div class="container">
        <h2>用户设置</h2>
        <div class="form-group">
            <label for="userId">用户名:</label>
            <input type="text" id="userId" placeholder="请输入你的用户名">
        </div>
        <button onclick="setUser()">设置用户</button>
        <div id="userMessage"></div>
    </div>

    <div id="configSection" class="hidden">
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
            <button class="warning" onclick="manualExecute()">手动执行一次</button>
            <div id="configsList"></div>
        </div>
    </div>

    <script>
        let currentUserId = null;

        document.addEventListener('DOMContentLoaded', function() {
            const configForm = document.getElementById('configForm');
            configForm.addEventListener('submit', async function(event) {
                event.preventDefault();
                
                if (!currentUserId) {
                    showMessage('configMessage', '请先设置用户名', 'error');
                    return;
                }

                const formData = {
                    userId: currentUserId,
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
                        configForm.reset();
                        loadConfigs();
                    } else {
                        showMessage('configMessage', '保存失败: ' + (result.error || '未知错误'), 'error');
                    }
                } catch (error) {
                    console.error('Save error:', error);
                    showMessage('configMessage', '保存过程中发生错误', 'error');
                }
            });
        });

        function setUser() {
            const userId = document.getElementById('userId').value.trim();
            if (!userId) {
                showMessage('userMessage', '请输入用户名', 'error');
                return;
            }

            currentUserId = userId;
            document.getElementById('configSection').classList.remove('hidden');
            showMessage('userMessage', '用户设置成功！', 'success');
            loadConfigs();
        }

        async function manualExecute() {
            try {
                const response = await fetch('/api/hangup/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('手动执行完成，请刷新配置列表查看结果');
                    loadConfigs();
                }
            } catch (error) {
                console.error('Manual execute error:', error);
                alert('手动执行失败');
            }
        }

        async function loadConfigs() {
            if (!currentUserId) return;

            try {
                const response = await fetch(\`/api/hangup/configs?userId=\${currentUserId}\`);
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
                    <p><strong>执行次数:</strong> \${config.executionCount || 0} 次</p>
                    <p><strong>上次执行:</strong> \${config.lastExecuted ? new Date(config.lastExecuted).toLocaleString() : '未执行'}</p>
                    <p><strong>执行结果:</strong> \${config.lastResult || '无'}</p>
                    <p><strong>创建时间:</strong> \${new Date(config.createdAt).toLocaleString()}</p>
                    <button class="\${config.isActive ? 'danger' : 'success'}" onclick="toggleConfig('\${config.configId}')">
                        \${config.isActive ? '停止' : '启动'}
                    </button>
                    <button class="danger" onclick="deleteConfig('\${config.configId}')">删除配置</button>
                </div>
            \`).join('');
        }

        async function toggleConfig(configId) {
            try {
                const response = await fetch(\`/api/hangup/configs/\${configId}/toggle\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: currentUserId })
                });
                
                const result = await response.json();
                if (result.success) {
                    loadConfigs();
                }
            } catch (error) {
                console.error('Toggle error:', error);
            }
        }

        async function deleteConfig(configId) {
            if (!confirm('确定要删除这个配置吗？')) return;

            try {
                const response = await fetch(\`/api/hangup/configs/\${configId}\`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: currentUserId })
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

async function executeAllHangupTasks(env: Env, ctx: ExecutionContext) {
  try {
    console.log('=== 开始执行所有挂机任务 ===');
    
    const allKeys = await env.KV_BINDING.list({ prefix: 'stv_config:' });
    console.log(`找到 ${allKeys.keys.length} 个配置`);
    
    let executedCount = 0;
    
    for (const key of allKeys.keys) {
      try {
        const configData = await env.KV_BINDING.get(key.name);
        if (!configData) continue;
        
        const config: UserConfig = JSON.parse(configData);
        if (!config.isActive) {
          console.log(`配置 ${config.configName} 已停用，跳过`);
          continue;
        }
        
        console.log(`✅ 执行配置 ${config.configName}`);
        await executeHangupRequest(config, env);
        executedCount++;
        
      } catch (error) {
        console.error(`❌ 处理配置 ${key.name} 时出错:`, error);
      }
    }
    
    console.log(`=== 执行完成，共执行了 ${executedCount} 个配置 ===`);
  } catch (error) {
    console.error('❌ executeAllHangupTasks 错误:', error);
  }
}

async function executeHangupRequest(config: UserConfig, env: Env) {
  try {
    console.log(`🚀 开始执行挂机请求: ${config.configName} (${config.stvUID})`);
    
    const response = await fetch(`https://sangtacviet.app/io/user/online?ngmar=ol2&u=${config.stvUID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': config.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://sangtacviet.app/',
        'Origin': 'https://sangtacviet.app',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: 'sajax=online&ngmar=ol'
    });

    const result = await response.text();
    const success = response.ok && (result.includes('success') || result.includes('ok') || response.status === 200);
    
    config.lastExecuted = new Date().toISOString();
    config.lastResult = success ? '✅ 成功' : `❌ 失败: ${result.substring(0, 100)}`;
    config.executionCount = (config.executionCount || 0) + 1;
    
    console.log(`📊 挂机请求结果: ${config.configName} - ${config.lastResult}`);
    
    await env.KV_BINDING.put(`stv_config:${config.userId}:${config.configId}`, JSON.stringify(config));
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    config.lastExecuted = new Date().toISOString();
    config.lastResult = `❌ 错误: ${errorMsg}`;
    config.executionCount = (config.executionCount || 0) + 1;
    
    console.error(`💥 挂机请求错误: ${config.configName} - ${errorMsg}`);
    
    await env.KV_BINDING.put(`stv_config:${config.userId}:${config.configId}`, JSON.stringify(config));
  }
}

async function getUserConfigs(userId: string, env: Env): Promise<UserConfig[]> {
  const configs: UserConfig[] = [];
  const allKeys = await env.KV_BINDING.list({ prefix: `stv_config:${userId}:` });
  
  for (const key of allKeys.keys) {
    try {
      const configData = await env.KV_BINDING.get(key.name);
      if (configData) {
        const config: UserConfig = JSON.parse(configData);
        delete (config as any).cookie;
        configs.push(config);
      }
    } catch (error) {
      console.error(`Error loading config ${key.name}:`, error);
    }
  }
  
  return configs;
}

function generateConfigId(): string {
  return 'cfg_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 15);
}