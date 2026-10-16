import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/cormorant/wght.css'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/inter/wght-italic.css'
import './styles/tokens.css'
import './styles/components.css'
import './styles/dialogs.css'
import './styles/player.css'
import PlayerApp from './PlayerApp.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(<PlayerApp />)
