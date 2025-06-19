// server.js

require('dotenv').config(); // Carrega variáveis de ambiente do arquivo .env
const express = require('express');
const http = require('http'); // Necessário para integrar Socket.IO com Express
const socketio = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors'); // Para permitir requisições de diferentes origens (frontend)
const fileupload = require('express-fileupload'); // Para upload de arquivos (avatar)

const app = express();
const server = http.createServer(app);
// Configuração do Socket.IO para aceitar conexões de qualquer origem durante o desenvolvimento
const io = socketio(server, {
    cors: {
        origin: "*", // Permitir qualquer origem para o frontend (ajuste em produção)
        methods: ["GET", "POST"]
    }
});

const routes = require('./routes');
const { User, Game, LobbyRoom } = require('./models'); // Importar modelos necessários
const { validateMove, applyMove, checkGameEnd, getPieceColor } = require('./controllers'); // Importar lógica de jogo do controllers

// --- Conexão ao Banco de Dados MongoDB ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Conectado ao MongoDB Atlas com sucesso!'))
    .catch(err => {
        console.error('Erro de conexão ao MongoDB:', err);
        process.exit(1); // Sai do processo se houver erro de conexão
    });

// --- Middlewares ---
app.use(cors()); // Habilita o CORS para todas as rotas
app.use(express.json()); // Habilita o parsing de JSON no corpo das requisições
app.use(express.urlencoded({ extended: true })); // Habilita o parsing de URL-encoded bodies
app.use(fileupload({
    useTempFiles: true, // Usa arquivos temporários para upload
    tempFileDir: '/tmp/' // Diretório para armazenar arquivos temporários
}));

// --- Rotas da API ---
app.use('/api', routes); // Prefixo '/api' para todas as rotas definidas em routes.js

// --- Lógica de Socket.IO ---
io.on('connection', socket => {
    console.log(`Novo cliente conectado: ${socket.id}`);

    // Um usuário se conecta ao lobby geral para ver as apostas
    socket.on('joinLobby', async () => {
        socket.join('lobby');
        console.log(`Cliente ${socket.id} entrou no lobby.`);
        // O cliente deve solicitar a lista de lobbies via REST API ao entrar na página do lobby.
        // As atualizações de lobby (criação/aceitação de apostas) serão emitidas globalmente.
    });

    // Um usuário cria ou entra em uma sala de jogo específica
    socket.on('joinGame', async ({ gameId, userId }) => {
        if (!gameId || !userId) {
            console.error(`joinGame: gameId ou userId ausente para ${socket.id}`);
            return;
        }

        try {
            const game = await Game.findById(gameId).populate('players', 'username avatar');
            if (!game) {
                console.error(`Jogo não encontrado para gameId: ${gameId}`);
                socket.emit('gameError', { message: 'Partida não encontrada.' });
                return;
            }

            // Verifica se o usuário é um dos jogadores da partida
            const isPlayer = game.players.some(p => String(p._id) === String(userId));
            if (!isPlayer) {
                console.error(`Usuário ${userId} não é jogador da partida ${gameId}`);
                socket.emit('gameError', { message: 'Você não é um jogador desta partida.' });
                return;
            }

            socket.join(gameId); // Cada partida tem sua própria sala Socket.IO
            console.log(`Usuário ${userId} (${socket.id}) entrou na sala do jogo: ${gameId}`);

            // Enviar o estado atual do jogo para o jogador que acabou de entrar
            io.to(gameId).emit('gameState', {
                boardState: game.boardState,
                currentPlayer: game.currentPlayer,
                players: game.players.map(p => ({
                    id: p._id,
                    username: p.username,
                    avatar: p.avatar
                })),
                status: game.status,
                betAmount: game.betAmount,
                winner: game.winner
            });

            // Notificar o outro jogador que o adversário entrou na sala (se ainda não estiver lá)
            io.to(gameId).emit('playerJoined', { userId });


        } catch (error) {
            console.error(`Erro ao juntar-se ao jogo ${gameId}:`, error);
            socket.emit('gameError', { message: 'Erro ao entrar na partida.' });
        }
    });

    // Evento de movimento de peça
    socket.on('makeMove', async ({ gameId, userId, from, to }) => {
        try {
            let game = await Game.findById(gameId);

            if (!game || game.status !== 'in-progress') {
                socket.emit('gameError', { message: 'Partida não encontrada ou não está em andamento.' });
                return;
            }

            // Verifica se é a vez do jogador que está tentando mover
            if (String(game.currentPlayer) !== String(userId)) {
                socket.emit('gameError', { message: 'Não é a sua vez de jogar.' });
                return;
            }

            const player1Id = game.players[0];
            const player2Id = game.players[1];
            let currentPlayerColor;

            // Determinar a cor do jogador atual (Brancas ou Pretas)
            // Assumimos que o criador do jogo (player1) é sempre branco e o player2 é preto.
            if (String(userId) === String(player1Id)) {
                currentPlayerColor = 'white';
            } else if (String(userId) === String(player2Id)) {
                currentPlayerColor = 'black';
            } else {
                socket.emit('gameError', { message: 'Você não é um jogador válido desta partida.' });
                return;
            }

            // Validar o movimento usando a lógica do controllers
            const validationResult = validateMove(game.boardState, from, to, currentPlayerColor);

            if (!validationResult.isValid) {
                socket.emit('gameError', { message: validationResult.message });
                return;
            }

            // Aplicar o movimento ao tabuleiro
            const newBoardState = applyMove(game.boardState, from, to);

            // Registrar o movimento
            game.moves.push({
                player: userId,
                from: { row: from.row, col: from.col },
                to: { row: to.row, col: to.col },
                capturedPieces: validationResult.isCapture ? [`${getPieceColor(game.boardState[from.row + (to.row - from.row) / 2][from.col + (to.col - from.col) / 2])}_piece`] : [] // Apenas para registro, mais robusto com IDs de peça
            });
            game.boardState = newBoardState;

            // Verificar o fim do jogo
            const gameEndResult = checkGameEnd(game.boardState, getPieceColor(newBoardState[to.row][to.col]) === 'white' ? 'black' : 'white'); // Verifica o próximo jogador
            let winnerId = null;
            let loserId = null;

            if (gameEndResult.gameOver) {
                game.status = 'completed';
                game.completedAt = Date.now();

                if (gameEndResult.winnerColor === currentPlayerColor) {
                    // O jogador que acabou de fazer o movimento venceu
                    winnerId = userId;
                    loserId = (String(player1Id) === String(userId)) ? player2Id : player1Id;
                } else {
                    // O adversário venceu (porque o jogador atual não tem mais movimentos válidos)
                    winnerId = (String(player1Id) === String(userId)) ? player2Id : player1Id;
                    loserId = userId;
                }

                game.winner = winnerId;
                game.loser = loserId;

                // Creditando o ganhador e aplicando comissão
                const winnerUser = await User.findById(winnerId);
                const loserUser = await User.findById(loserId);

                const commissionRate = await Setting.findOne({ name: 'platformCommissionRate' });
                const actualCommissionRate = commissionRate ? parseFloat(commissionRate.value) : 0.10; // Default 10%

                // O valor total do pote é 2 * betAmount (um de cada jogador)
                const totalPot = game.betAmount * 2;
                const winnerReceives = totalPot - (game.betAmount * actualCommissionRate); // Vencedor recebe o pote menos a comissão sobre o valor "ganho" (que é o betAmount do oponente)

                if (winnerUser) {
                    winnerUser.balance += winnerReceives;
                    await winnerUser.save();
                }

                // Notificar ambos os jogadores sobre o saldo atualizado (opcional, podem verificar no perfil)
                io.to(String(winnerId)).emit('balanceUpdate', { newBalance: winnerUser.balance });
                if (loserUser) { // O perdedor já teve seu saldo debitado ao aceitar/criar a aposta
                    io.to(String(loserId)).emit('balanceUpdate', { newBalance: loserUser.balance });
                }

            } else {
                // Trocar o jogador atual
                game.currentPlayer = (String(game.currentPlayer) === String(player1Id)) ? player2Id : player1Id;
            }

            await game.save();

            // Emitir o novo estado do jogo para todos na sala
            io.to(gameId).emit('gameState', {
                boardState: game.boardState,
                currentPlayer: game.currentPlayer,
                status: game.status,
                winner: game.winner,
                message: validationResult.message || (gameEndResult.gameOver ? gameEndResult.reason : 'Movimento válido.')
            });

            // Se o jogo terminou, notificar o lobby se a sala era de "in-game"
            if (game.status === 'completed') {
                await LobbyRoom.findOneAndUpdate({ gameId: game._id }, { status: 'closed' });
                io.to('lobby').emit('lobbyUpdate'); // Avisa o lobby para atualizar a lista
                io.to(gameId).emit('gameEnded', { winnerId: game.winner, loserId: game.loser, reason: gameEndResult.reason });
            }

        } catch (error) {
            console.error(`Erro ao fazer movimento no jogo ${gameId}:`, error);
            socket.emit('gameError', { message: 'Erro interno ao processar o movimento.' });
        }
    });


    // Evento quando um cliente se desconecta
    socket.on('disconnect', () => {
        console.log(`Cliente desconectado: ${socket.id}`);
        // TODO: Lógica para lidar com desconexões em partidas (ex: declarar vitória por abandono)
    });
});

// --- Rota de Teste Simples ---
app.get('/', (req, res) => {
    res.send('Servidor BrainSkill está online!');
});

// --- Iniciar o Servidor ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));


/*
Para executar este arquivo localmente:

1.  Certifique-se de que os arquivos `package.json`, `models.js`, `routes.js` e `controllers.js`
    estejam no mesmo diretório.
2.  Tenha um arquivo `.env` na raiz do projeto com as variáveis de ambiente necessárias
    (PORT, MONGODB_URI, JWT_SECRET, EMAIL_HOST, etc., e CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).
3.  Instale as dependências usando `npm install`.
4.  Para iniciar o servidor em modo de desenvolvimento com `nodemon` (auto-reload): `npm run dev`.
5.  Para iniciar o servidor em modo de produção: `npm start`.

Após iniciar o servidor, você poderá acessar a API REST e a comunicação WebSocket.
Lembre-se que para o upload de arquivos via `express-fileupload`, as requisições
POST/PUT para `/api/upload-avatar` devem enviar um `FormData` com o campo `avatar`.
*/