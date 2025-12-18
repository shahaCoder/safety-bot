# PM2 Auto-Start Configuration

## Why Bot Might Stop at Night

If the bot stops working at night, it's usually because:
1. **PM2 not configured for auto-restart** - PM2 needs to be set up to restart on server reboot
2. **Server reboot** - DigitalOcean droplets may reboot during maintenance
3. **Process crash** - Unhandled errors can crash the bot

## Setup PM2 Auto-Start

### 1. Save PM2 Process List
```bash
pm2 save
```

### 2. Generate Startup Script
```bash
pm2 startup
```
This will output a command like:
```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u your_username --hp /home/your_username
```
**Run that command** (it sets up systemd to auto-start PM2 on boot)

### 3. Verify Auto-Start
```bash
# Check PM2 status
pm2 status

# Check if startup script is installed
pm2 startup

# Test: reboot server and check if bot auto-starts
# (or just restart PM2: pm2 restart all)
```

## Monitoring

### Check Bot Uptime
```bash
pm2 status
pm2 logs pti-bot --lines 50
```

### Check Heartbeat Logs
The bot logs a heartbeat every 10 minutes:
```
💓 [HEARTBEAT] Bot alive, uptime: X.XXh
```

If you don't see heartbeats, the bot may have stopped.

### Check Cron Execution
Look for cron ticks in logs:
```
⏰ [CRON SAFETY] tick
```

If cron stops running, check for errors in logs.

## Rate Limiting Protection

The bot now has built-in protection against spam on restart:
- **MAX_EVENTS_PER_CRON_RUN** (default: 25) - limits events processed per cron run
- Set in `.env`: `MAX_EVENTS_PER_CRON_RUN=30` (optional)

This prevents the bot from sending hundreds of accumulated events when it restarts after being down.

## Troubleshooting

### Bot Not Starting After Reboot
1. Check PM2 startup: `pm2 startup` (should show it's installed)
2. Check PM2 status: `pm2 status`
3. Check systemd: `systemctl status pm2-your_username`
4. Check logs: `pm2 logs pti-bot`

### Bot Crashes Frequently
1. Check error logs: `pm2 logs pti-bot --err`
2. Check memory: `pm2 monit`
3. Increase memory limit if needed: `pm2 start ecosystem.config.js --max-memory-restart 500M`

### Cron Not Running
1. Check if bot process is alive: `pm2 status`
2. Check for errors in cron: look for `❌ Error in cron safety check`
3. Check if cron schedule is correct: `* * * * *` (every minute)

