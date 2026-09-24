import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import BlobTestbed from './BlobTestbed.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BlobTestbed />
  </StrictMode>,
)
