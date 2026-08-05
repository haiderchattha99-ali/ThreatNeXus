# ThreatNeXus - Quick Start Guide

Get up and running with ThreatNeXus in 5 minutes!

## ⚡ Super Quick Start (1 minute)

```bash
# You're already in the project directory
npm run dev
```

Open your browser: **http://localhost:5173**

## 🔐 Login

Use these test credentials:
```
Email: ali@example.com
Password: password123
```

## 🎯 What You'll See

After login, explore these pages:

1. **Dashboard** - Threat statistics and charts
2. **Threats** - Search and manage threats
3. **Upload** - Upload CSV files
4. **Profile** - User information

## 📁 Project Location

```
/vercel/share/v0-project/threat-nexus/
```

## 📋 Important Files

| File | Purpose |
|------|---------|
| `src/App.jsx` | Main routing |
| `src/pages/` | All 5 pages |
| `src/components/` | Navbar, Sidebar, ProtectedRoute |
| `src/services/api.js` | API integration |
| `src/context/AuthContext.jsx` | Authentication |
| `vite.config.js` | Build configuration |

## 🚀 Available Commands

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

## 🔌 API Connection

The frontend expects a backend at:
```
http://localhost:5000/api
```

For API details, see `API_INTEGRATION.md`

## 🛠️ Tech Stack

- React 19
- Vite
- Material-UI
- React Router
- Axios
- Recharts

## 📚 Documentation

- **README.md** - Full project documentation
- **DEVELOPMENT.md** - Development guidelines
- **API_INTEGRATION.md** - API endpoint specifications
- **PROJECT_SUMMARY.md** - Feature overview

## 🐛 Troubleshooting

**Can't connect to backend?**
- Make sure your backend is running on port 5000
- Check that API endpoints match `API_INTEGRATION.md`

**Port already in use?**
- Change the port in `vite.config.js`
- Or kill the process: `lsof -ti :5173 | xargs kill -9`

**Build issues?**
- Delete `node_modules` and run `npm install`
- Clear `.next` or `dist` folder

## 🎨 UI Features

✅ Professional dark mode SOC dashboard
✅ Interactive charts with Recharts
✅ Material-UI components
✅ Responsive design (mobile, tablet, desktop)
✅ Toast notifications
✅ Loading states
✅ Error handling

## 📊 Dashboard Pages

1. **Login** - Email/password authentication
2. **Dashboard** - Stats and visualizations
3. **Threats** - Data grid with search/filter
4. **Upload** - Drag-drop CSV upload
5. **Profile** - User information

## 🔑 Key Features

- ✅ JWT Authentication
- ✅ Protected routes
- ✅ Real-time data
- ✅ Search functionality
- ✅ CSV upload
- ✅ Responsive design
- ✅ Error handling
- ✅ Toast notifications

## 💡 Tips

1. Open DevTools (F12) to see network requests
2. Check the Network tab for API calls
3. Use React DevTools to inspect components
4. Check Console for any errors

## 🌐 Browser Support

- Chrome/Chromium (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## ⚙️ Environment Variables

Create `.env.local` if needed:
```
VITE_API_BASE_URL=http://localhost:5000/api
```

See `.env.example` for all options.

## 📱 Responsive Breakpoints

- Mobile: < 600px
- Tablet: 600px - 960px
- Desktop: > 960px

All pages are fully responsive!

## 🎓 Learning Resources

- [React Docs](https://react.dev)
- [Material-UI Docs](https://mui.com)
- [React Router Docs](https://reactrouter.com)
- [Vite Docs](https://vitejs.dev)

## 🤝 Contributing

1. Create a feature branch
2. Make your changes
3. Test thoroughly
4. Commit and push
5. Create a pull request

## 📞 Need Help?

1. Check the documentation files
2. Look at the error messages in console
3. Review the API integration guide
4. Check the development guide

## ✅ Checklist

- [ ] Backend running on port 5000
- [ ] Frontend running on port 5173
- [ ] Can login with test credentials
- [ ] Dashboard loads without errors
- [ ] Can view threats list
- [ ] Can search threats
- [ ] Can upload CSV
- [ ] Can view profile

## 🎉 You're Ready!

Your ThreatNeXus frontend is ready to go!

```
npm run dev
```

**Access it at: http://localhost:5173**

---

**Next Steps:**
1. ✅ Implement backend API endpoints
2. ✅ Connect to database
3. ✅ Deploy to production
4. ✅ Add additional features

**Current Status:** Frontend Complete ✓ | Backend Ready ✓

Enjoy! 🚀
