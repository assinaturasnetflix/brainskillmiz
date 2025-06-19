require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const setupRoutes = require('./routes');
const { initializeSocketIO } = require('./controllers');

// Diagnóstico de carregamento de variáveis de ambiente
console.log('--- Verificação de Variáveis de Ambiente ---');
console.log('MONGODB_URI:', process.env.MONGODB_URI ? 'Carregada' : 'NÃO CARREGADA');
console.log('JWT_SECRET:', process.env.JWT_SECRET ? 'Carregada' : 'NÃO CARREGADA');
console.log('EMAIL_USER:', process.env.EMAIL_USER ? 'Carregada' : 'NÃO CARREGADA');
console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? 'Carregada' : 'NÃO CARREGADA');
console.log('CLOUDINARY_NAME:', process.env.CLOUDINARY_NAME ? 'Carregada' : 'NÃO CARREGADA');
console.log('CLOUDINARY_API_KEY:', process.env.CLOUDINARY_API_KEY ? 'Carregada' : 'NÃO CARREGADA');
console.log('CLOUDINARY_API_SECRET:', process.env.CLOUDINARY_API_SECRET ? 'Carregada' : 'NÃO CARREGADA');
console.log('PORT:', process.env.PORT ? 'Carregada' : 'NÃO CARREGADA');
console.log('-------------------------------------------');


const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());

mongoose.connect(MONGODB_URI)
    .then(() => console.log('Conectado ao MongoDB Atlas com sucesso!'))
    .catch(err => {
        console.error('Erro ao conectar ao MongoDB Atlas:', err);
        process.exit(1);
    });

setupRoutes(app);

initializeSocketIO(io);

app.get('/', (req, res) => {
    res.send('Servidor BrainSkill está online!');
});

server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
});
