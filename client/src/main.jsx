import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './screen-rooms.css';

// Observação: propositalmente SEM <React.StrictMode> aqui.
// O StrictMode monta/desmonta os componentes duas vezes de propósito
// (em desenvolvimento) para ajudar a achar bugs, mas isso faz o
// VoiceChannel entrar/sair do canal de voz duas vezes rapidinho,
// bagunçando a sincronia de quem está na chamada com o outro lado.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
