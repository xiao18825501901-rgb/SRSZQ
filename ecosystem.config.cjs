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
      SRSZQ_QUEUE_TIMEOUT_MS: '60000',
      SRSZQ_AI_DELAY_MS: '350',
      SRSZQ_DISCONNECT_SKIP_MS: '30000',
      SRSZQ_FORFEIT_GRACE_MS: '10000',
      SRSZQ_INVITE_GATHER_MS: '30000',
    },
  }],
};
