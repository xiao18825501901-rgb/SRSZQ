module.exports = {
  apps: [{
    name: 'srszq-backend',
    cwd: '/var/www/SRSZQ',
    script: '/var/www/SRSZQ/node_modules/.bin/tsx',
    args: 'backend/src/server.ts',
    interpreter: 'none',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '700M',
    env: {
      NODE_ENV: 'production',
      PORT: '8080',
      SRSZQ_WS_PORT: '8081',
      // 增量 B：真人等待 20 秒（此前为 60000）。这里必须与代码默认值一致，
      // 否则代码改了、线上仍按这个环境变量等 60 秒 —— 实测踩到过（前端如实显示 59 秒）。
      SRSZQ_QUEUE_TIMEOUT_MS: '20000',
      SRSZQ_AI_DELAY_MS: '350',
      SRSZQ_DISCONNECT_SKIP_MS: '30000',
      SRSZQ_FORFEIT_GRACE_MS: '10000',
      SRSZQ_TURN_TIMEOUT_MS: '30000',
      SRSZQ_INVITE_GATHER_MS: '30000',
      SRSZQ_ALLOWED_ORIGINS: 'https://srszq.com,https://www.srszq.com,https://srszq.netlify.app',
    },
  }],
};
