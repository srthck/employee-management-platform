# Employee Management System

An enterprise-grade employee management platform built with React, Node.js, Express, and MongoDB. Designed for scalability, security, and maintainability.

## Tech Stack

### Frontend
- **React 18** with Vite (lightning-fast bundling)
- **React Router v6** (client-side routing)
- **Tailwind CSS** (utility-first styling)
- **Axios** (HTTP client with interceptors)

### Backend
- **Node.js** with Express.js (scalable REST API)
- **MongoDB Atlas** (cloud database)
- **Mongoose** (schema validation and modeling)
- **JWT** (stateless authentication)
- **bcrypt** (password hashing)

### Deployment
- **Frontend**: Vercel
- **Backend**: Render
- **Database**: MongoDB Atlas

## Project Structure

```
EMPLOYEE MANAGEMENT SYSTEM/
├── backend/                    # Express API server
│   ├── src/
│   │   ├── config/            # Configuration (database, environment)
│   │   ├── models/            # Mongoose schemas
│   │   ├── routes/            # API routes
│   │   ├── controllers/       # Business logic
│   │   ├── middleware/        # Custom middleware
│   │   ├── utils/             # Utilities
│   │   └── app.js             # Express app setup
│   ├── .env.example           # Environment variables template
│   ├── .env                   # (Git ignored)
│   ├── package.json
│   └── server.js              # Entry point
│
├── frontend/                   # React application
│   ├── src/
│   │   ├── components/        # Reusable UI components
│   │   ├── pages/             # Page components
│   │   ├── services/          # API service layer
│   │   ├── hooks/             # Custom React hooks
│   │   ├── contexts/          # React context (auth, etc.)
│   │   ├── utils/             # Utility functions
│   │   ├── App.jsx            # Main app component
│   │   └── main.jsx           # Entry point
│   ├── .env.example
│   ├── .env                   # (Git ignored)
│   ├── package.json
│   ├── vite.config.js
│   └── tailwind.config.js
│
└── docs/                       # Documentation
```

## Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn
- MongoDB Atlas account

### Backend Setup

1. Navigate to backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file (copy from `.env.example`):
```bash
cp .env.example .env
```

4. Configure your MongoDB URI in `.env`:
```
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/employee_management
PORT=5000
NODE_ENV=development
```

5. Start the server:
```bash
npm start
```

Server runs on `http://localhost:5000`

### Frontend Setup

1. Navigate to frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Configure API endpoint in `.env`:
```
VITE_API_URL=http://localhost:5000/api
```

5. Start development server:
```bash
npm run dev
```

Frontend runs on `http://localhost:5173`

## API Health Check

Verify the backend is running:

```bash
curl http://localhost:5000/api/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-05-30T10:30:00Z",
  "uptime": 125.34
}
```

## Development Standards

- **Code Style**: Clean Code principles, ESLint configuration
- **Architecture**: Separation of concerns, scalable folder structure
- **Security**: Environment variables, no hardcoded secrets, JWT validation
- **Database**: Mongoose schema validation, proper indexing
- **Error Handling**: Centralized error middleware, proper HTTP status codes

## Contributing

This project follows enterprise software engineering standards:
- Production-grade code only
- Scalable architecture
- Security-first mindset
- Clean, maintainable code

## Team

Built with senior software engineering standards for enterprise use.

## Status

**Day 1**: Foundation setup (in progress)
- [x] Git initialized
- [x] Project structure created
- [ ] Backend setup
- [ ] Frontend setup
- [ ] MongoDB connection
- [ ] Health check API
