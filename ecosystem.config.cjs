// pm2 process definition for the front-end server.
//
// Why this file exists: `pm2 restart` stops the process before starting the replacement, so
// every deploy left a one-to-two second window where nothing was listening on 5175 and nginx
// answered with its own 502 page. Cluster mode with two workers lets `pm2 reload` cycle them
// one at a time — the listening socket is owned by the pm2 master and never released, so the
// site stays up across a deploy.
//
// .cjs, not .js: package.json sets "type": "module" and pm2 loads this config as CommonJS.
//
// Only hliq-v2 is declared here. hliq-strat and hliq-notify are long-running stateful
// processes (bots, push subscriptions) that must stay single-instance and are deliberately
// left under their existing fork-mode definitions — do not add them to this file.
module.exports = {
  apps: [
    {
      name: 'hliq-v2',
      script: './serve-prod.js',
      cwd: '/root/hliq-v2',
      exec_mode: 'cluster',
      // Two is enough to make reloads seamless; this is a static file server and a proxy, so
      // it is nowhere near CPU-bound and more workers would just add memory for nothing.
      instances: 2,
      autorestart: true,
      // The dist/ bundle is replaced on every deploy; pm2's watcher would restart the workers
      // mid-build and fight the reload we are doing deliberately.
      watch: false,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
}
