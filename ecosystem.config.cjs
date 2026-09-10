module.exports = {
  apps: [
    {
      name: "los-barrios-bot",
      cwd: __dirname,
      script: "dist/bot.js",
      interpreter: "node",
      node_args: "--env-file=.env",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
