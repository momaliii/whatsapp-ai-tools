# Deployment Guide for Render.com

## 🚀 Quick Deploy

1. **Fork/Clone** this repository to your GitHub account
2. **Connect to Render**:
   - Go to [render.com](https://render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
3. **Configure Environment**:
   - **Name**: `whatsapp-agent` (or your preferred name)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Starter` (or higher for better performance)

## 🔧 Environment Variables

Set these in your Render dashboard under "Environment":

### Required:
- `OPENAI_API_KEY` - Your OpenAI API key
- `ADMIN_PASSWORD` - Password for dashboard access

### Optional:
- `NODE_ENV` - Set to `production`
- `OPENAI_MODEL` - Default: `gpt-4o-mini`
- `PORT` - Render will set this automatically

## 📁 File Structure

```
whatsapp-agent/
├── src/                    # Source code
├── public/                 # Static assets
├── config/                 # Configuration files
├── data/                   # Data storage
├── uploads/                # File uploads
├── package.json           # Dependencies
├── render.yaml            # Render configuration
├── Dockerfile             # Container configuration
└── .dockerignore          # Docker ignore file
```

## 🔐 Security Notes

- **ADMIN_PASSWORD**: Set a strong password for dashboard access
- **OPENAI_API_KEY**: Keep your API key secure
- **HTTPS**: Render provides automatic HTTPS
- **Authentication**: Dashboard requires password authentication

## 🌐 Access Your App

After deployment:
1. **Dashboard**: `https://your-app-name.onrender.com`
2. **Login**: Use the `ADMIN_PASSWORD` you set
3. **WhatsApp**: Scan QR code to connect

## 🔄 Updates

- **Auto-deploy**: Enabled by default
- **Manual deploy**: Available in Render dashboard
- **Rollback**: Previous versions can be restored

## 🐛 Troubleshooting

### Common Issues:

1. **Build fails**:
   - Check Node.js version (requires 18+)
   - Verify all dependencies in package.json

2. **WhatsApp connection issues**:
   - Check Puppeteer configuration
   - Verify environment variables

3. **Port issues**:
   - Render sets PORT automatically
   - App listens on 0.0.0.0 for all interfaces

### Logs:
- View logs in Render dashboard
- Check "Logs" tab for errors

## 📊 Monitoring

- **Health checks**: Automatic health monitoring
- **Uptime**: 99.9% uptime guarantee
- **Scaling**: Auto-scaling available on paid plans

## 💰 Costs

- **Free tier**: Limited hours per month
- **Paid plans**: Start at $7/month
- **Bandwidth**: Included in plans

## 🔗 Useful Links

- [Render Documentation](https://render.com/docs)
- [Node.js on Render](https://render.com/docs/deploy-node-express-app)
- [Environment Variables](https://render.com/docs/environment-variables)
