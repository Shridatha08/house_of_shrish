import { Routes, Route, Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { CartProvider } from './context/CartContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { getMySubscriptions } from './api'
import Menu from './pages/Menu'
import Checkout from './pages/Checkout'
import Payment from './pages/Payment'
import Login from './pages/Login'
import EventsCalendar from './pages/EventsCalendar'
import AdminHolidays from './pages/AdminHolidays'
import Profile from './pages/Profile'
import Invoice from './pages/Invoice'
import logo from '../../logo_white.png'
import calendarIcon from '../../calendar.png'
import userIcon from '../../user.png'
import './App.css'

function HeaderActions() {
  const { user, logout } = useAuth()

  if (!user) {
    return (
      <Link to="/login" className="btn-header">
        Register / Login
      </Link>
    )
  }

  return (
    <div className="header-account">
      <div className="header-account-row">
        <Link to="/profile" className="profile-icon-link">
          <img src={userIcon} alt="Edit profile" className="profile-icon" />
        </Link>
        <span>Hi, {user.name.split(' ')[0]}</span>
        <button type="button" className="btn-link btn-link-light" onClick={logout}>
          Logout
        </button>
      </div>
      <Link to="/events" className="btn-header btn-header-outline">
        <img src={calendarIcon} alt="" className="btn-header-icon" />
        Events Calendar
      </Link>
    </div>
  )
}

function SubscriptionExpiryBanner() {
  const { user, token } = useAuth()
  const [expiringItems, setExpiringItems] = useState([])

  useEffect(() => {
    if (!user) {
      setExpiringItems([])
      return
    }
    getMySubscriptions(token)
      .then((subs) => setExpiringItems(subs.filter((s) => s.expiresToday)))
      .catch(() => setExpiringItems([]))
  }, [user, token])

  if (expiringItems.length === 0) return null

  return (
    <div className="expiry-banner">
      Your monthly subscription ends today, renew to enjoy delicious home meal
    </div>
  )
}

function App() {
  return (
    <AuthProvider>
      <CartProvider>
        <header className="app-header">
          <Link to="/" className="brand">
            <img src={logo} alt="House of Shrish" className="brand-logo" />
            <span className="brand-text">
              <span className="brand-name">House of Shrish</span>
              <span className="brand-tagline">The Luxury of Eating Well</span>
            </span>
          </Link>
          <HeaderActions />
        </header>
        <SubscriptionExpiryBanner />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Menu />} />
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/payment/:id" element={<Payment />} />
            <Route path="/login" element={<Login />} />
            <Route path="/events" element={<EventsCalendar />} />
            <Route path="/admin/holidays" element={<AdminHolidays />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/invoice/:id" element={<Invoice />} />
          </Routes>
        </main>
      </CartProvider>
    </AuthProvider>
  )
}

export default App
