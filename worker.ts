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
    <title>STV 自动挂机管理系统</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .main-container {
            max-width: 1000px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
            color: white;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }

        .header .subtitle {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 40px rgba(0,0,0,0.25);
        }

        .card-header {
            display: flex;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f0f0f0;
        }

        .card-header i {
            font-size: 1.5rem;
            margin-right: 10px;
            color: #667eea;
        }

        .card-header h2 {
            color: #333;
            font-size: 1.4rem;
        }

        .info-banner {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 25px;
            text-align: center;
        }

        .info-banner i {
            font-size: 2rem;
            margin-bottom: 10px;
            display: block;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #333;
        }

        .form-control {
            width: 100%;
            padding: 12px 15px;
            border: 2px solid #e1e5e9;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        .form-control:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .btn {
            padding: 12px 25px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-right: 10px;
            margin-bottom: 10px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }

        .btn-primary {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
        }

        .btn-success {
            background: linear-gradient(45deg, #56ab2f, #a8e6cf);
            color: white;
        }

        .btn-danger {
            background: linear-gradient(45deg, #ff416c, #ff4b2b);
            color: white;
        }

        .btn-warning {
            background: linear-gradient(45deg, #f093fb, #f5576c);
            color: white;
        }

        .btn-info {
            background: linear-gradient(45deg, #4facfe, #00f2fe);
            color: white;
        }

        .config-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 20px;
        }

        .config-card {
            background: linear-gradient(145deg, #f8f9fa, #e9ecef);
            border-radius: 12px;
            padding: 20px;
            border-left: 5px solid #667eea;
            transition: all 0.3s ease;
        }

        .config-card:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.15);
        }

        .config-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }

        .config-title {
            font-size: 1.3rem;
            font-weight: bold;
            color: #333;
        }

        .status-badge {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .status-active {
            background: linear-gradient(45deg, #56ab2f, #a8e6cf);
            color: white;
        }

        .status-inactive {
            background: linear-gradient(45deg, #ff416c, #ff4b2b);
            color: white;
        }

        .config-info {
            margin-bottom: 15px;
        }

        .config-info-item {
            display: flex;
            margin-bottom: 8px;
            align-items: center;
        }

        .config-info-item i {
            width: 20px;
            color: #667eea;
            margin-right: 10px;
        }

        .config-info-item strong {
            min-width: 80px;
            color: #555;
        }

        .config-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        .message {
            padding: 12px 15px;
            border-radius: 8px;
            margin-top: 15px;
            font-weight: 500;
        }

        .message.success {
            background: linear-gradient(45deg, #d4edda, #c3e6cb);
            color: #155724;
            border-left: 4px solid #28a745;
        }

        .message.error {
            background: linear-gradient(45deg, #f8d7da, #f1b0b7);
            color: #721c24;
            border-left: 4px solid #dc3545;
        }

        .hidden {
            display: none;
        }

        .empty-state {
            text-align: center;
            padding: 40px;
            color: #666;
        }

        .empty-state i {
            font-size: 3rem;
            margin-bottom: 20px;
            color: #ccc;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 2rem;
            }
            
            .card {
                padding: 20px;
            }
            
            .config-grid {
                grid-template-columns: 1fr;
            }
        }

        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: spin 1s ease-in-out infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="main-container">
        <div class="header">
            <h1><i class="fas fa-robot"></i> STV 自动挂机管理系统</h1>
            <p class="subtitle">智能化自动保持在线状态</p>
        </div>
        
        <div class="info-banner">
            <i class="fas fa-clock"></i>
            <h3>系统每4分钟自动执行一次所有启用的配置</h3>
            <p>添加配置后无需手动干预，系统将自动为您保持在线状态</p>
        </div>
        
        <div class="card">
            <div class="card-header">
                <i class="fas fa-user"></i>
                <h2>用户身份设置</h2>
            </div>
            <div class="form-group">
                <label for="userId"><i class="fas fa-id-card"></i> 用户名</label>
                <input type="text" id="userId" class="form-control" placeholder="请输入您的用户名">
            </div>
            <button class="btn btn-primary" onclick="setUser()">
                <i class="fas fa-sign-in-alt"></i> 设置用户
            </button>
            <div id="userMessage"></div>
        </div>

        <div id="configSection" class="hidden">
            <div class="card">
                <div class="card-header">
                    <i class="fas fa-plus-circle"></i>
                    <h2>添加新配置</h2>
                </div>
                <form id="configForm">
                    <div class="form-group">
                        <label for="configName"><i class="fas fa-tag"></i> 配置名称</label>
                        <input type="text" id="configName" class="form-control" placeholder="例如：主号、小号1、备用账号 等" required>
                    </div>
                    <div class="form-group">
                        <label for="stvUID"><i class="fas fa-hashtag"></i> STV 用户ID</label>
                        <input type="text" id="stvUID" class="form-control" placeholder="您的 STV 用户ID" required>
                    </div>
                    <div class="form-group">
                        <label for="cookie"><i class="fas fa-cookie-bite"></i> Cookie 信息</label>
                        <textarea id="cookie" class="form-control" rows="4" placeholder="请粘贴完整的 Cookie 内容" required></textarea>
                    </div>
                    <button type="submit" class="btn btn-success">
                        <i class="fas fa-save"></i> 保存配置
                    </button>
                </form>
                <div id="configMessage"></div>
            </div>

            <div class="card">
                <div class="card-header">
                    <i class="fas fa-list"></i>
                    <h2>我的配置管理</h2>
                </div>
                <div style="margin-bottom: 20px;">
                    <button class="btn btn-info" onclick="loadConfigs()">
                        <i class="fas fa-sync-alt"></i> 刷新列表
                    </button>
                    <button class="btn btn-warning" onclick="manualExecute()">
                        <i class="fas fa-play"></i> 立即执行一次
                    </button>
                </div>
                <div id="configsList"></div>
            </div>
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

                const submitBtn = event.target.querySelector('button[type="submit"]');
                const originalText = submitBtn.innerHTML;
                submitBtn.innerHTML = '<div class="loading"></div> 保存中...';
                submitBtn.disabled = true;

                const formData = {
                    userId: currentUserId,
                    configName: document.getElementById('configName').value.trim(),
                    stvUID: document.getElementById('stvUID').value.trim(),
                    cookie: document.getElementById('cookie').value.trim()
                };

                if (!formData.configName || !formData.stvUID || !formData.cookie) {
                    showMessage('configMessage', '请填写所有字段', 'error');
                    submitBtn.innerHTML = originalText;
                    submitBtn.disabled = false;
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

                submitBtn.innerHTML = originalText;
                submitBtn.disabled = false;
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
            const btn = event.target;
            const originalText = btn.innerHTML;
            btn.innerHTML = '<div class="loading"></div> 执行中...';
            btn.disabled = true;

            try {
                const response = await fetch('/api/hangup/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('✅ 手动执行完成，请刷新配置列表查看结果');
                    loadConfigs();
                }
            } catch (error) {
                console.error('Manual execute error:', error);
                alert('❌ 手动执行失败');
            }

            btn.innerHTML = originalText;
            btn.disabled = false;
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
                container.innerHTML = \`
                    <div class="empty-state">
                        <i class="fas fa-inbox"></i>
                        <h3>暂无配置</h3>
                        <p>点击上方"添加新配置"开始创建您的第一个挂机配置</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = \`
                <div class="config-grid">
                    \${configs.map(config => \`
                        <div class="config-card">
                            <div class="config-header">
                                <div class="config-title">\${config.configName}</div>
                                <div class="status-badge \${config.isActive ? 'status-active' : 'status-inactive'}">
                                    \${config.isActive ? '运行中' : '已停止'}
                                </div>
                            </div>
                            <div class="config-info">
                                <div class="config-info-item">
                                    <i class="fas fa-hashtag"></i>
                                    <strong>STV ID:</strong> \${config.stvUID}
                                </div>
                                <div class="config-info-item">
                                    <i class="fas fa-chart-line"></i>
                                    <strong>执行次数:</strong> \${config.executionCount || 0} 次
                                </div>
                                <div class="config-info-item">
                                    <i class="fas fa-clock"></i>
                                    <strong>上次执行:</strong> \${config.lastExecuted ? new Date(config.lastExecuted).toLocaleString() : '未执行'}
                                </div>
                                <div class="config-info-item">
                                    <i class="fas fa-check-circle"></i>
                                    <strong>执行结果:</strong> \${config.lastResult || '无'}
                                </div>
                                <div class="config-info-item">
                                    <i class="fas fa-calendar-plus"></i>
                                    <strong>创建时间:</strong> \${new Date(config.createdAt).toLocaleString()}
                                </div>
                            </div>
                            <div class="config-actions">
                                <button class="btn \${config.isActive ? 'btn-danger' : 'btn-success'}" onclick="toggleConfig('\${config.configId}')">
                                    <i class="fas \${config.isActive ? 'fa-stop' : 'fa-play'}"></i>
                                    \${config.isActive ? '停止' : '启动'}
                                </button>
                                <button class="btn btn-danger" onclick="deleteConfig('\${config.configId}')">
                                    <i class="fas fa-trash"></i> 删除
                                </button>
                            </div>
                        </div>
                    \`).join('')}
                </div>
            \`;
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
            if (!confirm('🗑️ 确定要删除这个配置吗？此操作不可恢复！')) return;

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
            element.innerHTML = message;
            element.className = \`message \${type}\`;
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