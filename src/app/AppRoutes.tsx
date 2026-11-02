import { Navigate, Route, Routes } from 'react-router-dom'
import LandingPage from '../site/LandingPage'
import ProductsPage from '../site/ProductsPage'
import HackathonPage from '../site/HackathonPage'
import ShopApp from '../shop/ShopApp'
import DashboardApp from '../dashboard/DashboardApp'
import ChatApp from '../chat/ChatApp'

// One app, one deployment, three routes. Unknown paths go back to the public page.
export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/products" element={<ProductsPage />} />
      <Route path="/hackathon" element={<HackathonPage />} />
      <Route path="/chat" element={<ChatApp />} />
      <Route path="/shop" element={<ShopApp />} />
      <Route path="/dashboard/*" element={<DashboardApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
