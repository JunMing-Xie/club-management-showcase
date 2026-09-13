module.exports = {
  apps: [
    {
      name: 'club-showcase-api',
      script: 'dist/server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      out_file: './logs/api-out.log',
      error_file: './logs/api-error.log',
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 4200,
      },
    },
  ],
}
