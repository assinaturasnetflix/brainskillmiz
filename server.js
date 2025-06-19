// server.js

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const fileupload = require('express-fileupload');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const routes = require('./routes');
const controllers = require('./controllers');
const { User, Game, LobbyRoom, Setting } = require('./models');

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Conectado ao MongoDB Atlas com sucesso!'))
    .catch(err => {
        console.error('Erro de conexão ao MongoDB:', err);
        process.exit(1);
    });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileupload({
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

app.use('/api', routes);

io.on('connection', socket => {
    console.log(`Novo cliente conectado: ${socket.id}`);

    socket.on('joinLobby', () => {
        socket.join('lobby');
        console.log(`Cliente ${socket.id} entrou no lobby.`);
    });

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

            const isPlayer = game.players.some(p => String(p._id) === String(userId));
            if (!isPlayer) {
                console.warn(`Usuário ${userId} não é jogador da partida ${gameId}.`);
                socket.emit('gameError', { message: 'Você não tem permissão para entrar nesta partida.' });
                return;
            }

            socket.join(gameId);
            console.log(`Usuário ${userId} (${socket.id}) entrou/reconectou na sala do jogo: ${gameId}`);

            // Sempre envie o estado mais recente do jogo para o cliente que acabou de entrar/reconectar
            io.to(socket.id).emit('gameState', {
                boardState: game.boardState,
                currentPlayer: game.currentPlayer,
                players: game.players.map(p => ({
                    id: p._id.toString(),
                    username: p.username,
                    avatar: p.avatar
                })),
                status: game.status,
                betAmount: game.betAmount,
                winner: game.winner ? game.winner.toString() : null,
                loser: game.loser ? game.loser.toString() : null,
            });

        } catch (error) {
            console.error(`Erro ao juntar-se ao jogo ${gameId}:`, error);
            socket.emit('gameError', { message: 'Erro ao entrar na partida.' });
        }
    });

    socket.on('makeMove', async ({ gameId, userId, from, to }) => {
        try {
            let game = await Game.findById(gameId).populate('players', 'username avatar');

            if (!game || game.status !== 'in-progress') {
                socket.emit('gameError', { message: 'Partida não encontrada ou não está em andamento.' });
                return;
            }

            if (String(game.currentPlayer) !== String(userId)) {
                socket.emit('gameError', { message: 'Não é a sua vez de jogar.' });
                return;
            }

            const player1Obj = game.players[0]; // Jogador 1 completo
            const player2Obj = game.players[1]; // Jogador 2 completo

            const player1Id = player1Obj._id;
            const player2Id = player2Obj._id;
            let currentPlayerColor;

            if (String(userId) === String(player1Id)) {
                currentPlayerColor = 'white';
            } else if (String(userId) === String(player2Id)) {
                currentPlayerColor = 'black';
            } else {
                socket.emit('gameError', { message: 'Você não é um jogador válido desta partida.' });
                return;
            }

            const { validateMove, applyMove, checkGameEnd, getPieceColor } = controllers; 

            const validationResult = validateMove(game.boardState, from, to, currentPlayerColor);

            if (!validationResult.isValid) {
                socket.emit('gameError', { message: validationResult.message });
                return;
            }

            const newBoardState = applyMove(game.boardState, from, to);

            game.moves.push({
                player: userId,
                from: { row: from.r, col: from.c },
                to: { row: to.r, col: to.c },
                capturedPieces: validationResult.isCapture ? [`${getPieceColor(game.boardState[from.r + (to.r - from.r) / 2][from.c + (to.c - from.c) / 2])}_piece`] : [] 
            });
            game.boardState = newBoardState;

            const nextPlayerColor = currentPlayerColor === 'white' ? 'black' : 'white';
            const gameEndResult = checkGameEnd(game.boardState, nextPlayerColor);
            let winnerId = null;
            let loserId = null;

            if (gameEndResult.gameOver) {
                game.status = 'completed';
                game.completedAt = Date.now();

                if (gameEndResult.winnerColor === currentPlayerColor) {
                    winnerId = userId;
                    loserId = (String(player1Id) === String(userId)) ? player2Id : player1Id;
                } else {
                    winnerId = (String(player1Id) === String(userId)) ? player2Id : player1Id;
                    loserId = userId;
                }

                game.winner = winnerId;
                game.loser = loserId;

                const winnerUser = await User.findById(winnerId);

                const commissionSetting = await Setting.findOne({ name: 'platformCommissionRate' });
                const commissionRate = commissionSetting ? parseFloat(commissionSetting.value) : 0.10;

                const totalPot = game.betAmount * 2;
                const winnerReceives = totalPot - (game.betAmount * commissionRate); 
                
                if (winnerUser) {
                    winnerUser.balance += winnerReceives;
                    await winnerUser.save();
                }

            } else {
                // ATENÇÃO CRÍTICA: Trocar o jogador atual para o ID DO PRÓXIMO JOGADOR
                game.currentPlayer = (String(userId) === String(player1Id)) ? player2Id : player1Id;
            }

            await game.save(); // SALVAR O ESTADO ATUALIZADO DO JOGO NO BANCO DE DADOS

            // Buscar o jogo novamente COM JOGADORES POPULADOS para garantir que o gameState está completo
            const updatedGame = await Game.findById(gameId).populate('players', 'username avatar').populate('winner', 'username').populate('loser', 'username');

            // Emitir o novo estado para TODOS os clientes na sala do jogo
            io.to(gameId).emit('gameState', {
                boardState: updatedGame.boardState,
                currentPlayer: updatedGame.currentPlayer, // Este é o ID do jogador da próxima vez
                players: updatedGame.players.map(p => ({
                    id: p._id.toString(),
                    username: p.username,
                    avatar: p.avatar
                })),
                status: updatedGame.status,
                betAmount: updatedGame.betAmount,
                winner: updatedGame.winner ? updatedGame.winner._id.toString() : null,
                loser: updatedGame.loser ? updatedGame.loser._id.toString() : null,
            });

            if (updatedGame.status === 'completed' || updatedGame.status === 'cancelled') {
                await LobbyRoom.findOneAndUpdate({ gameId: updatedGame._id }, { status: 'closed' });
                io.to('lobby').emit('lobbyUpdate');
                io.to(gameId).emit('gameEnded', { 
                    winnerId: updatedGame.winner ? updatedGame.winner._id.toString() : null, 
                    loserId: updatedGame.loser ? updatedGame.loser._id.toString() : null, 
                    reason: gameEndResult.reason || 'Partida finalizada.' 
                });
            }

        } catch (error) {
            console.error(`Erro no makeMove do jogo ${gameId}:`, error);
            socket.emit('gameError', { message: 'Erro interno ao processar o movimento. Tente novamente.' });
            
            // Em caso de erro, re-sincronizar o cliente com o estado atual do servidor
            try {
                const currentServerGame = await Game.findById(gameId).populate('players', 'username avatar');
                if (currentServerGame) {
                    io.to(socket.id).emit('gameState', {
                        boardState: currentServerGame.boardState,
                        currentPlayer: currentServerGame.currentPlayer,
                        players: currentServerGame.players.map(p => ({
                            id: p._id.toString(),
                            username: p.username,
                            avatar: p.avatar
                        })),
                        status: currentServerGame.status,
                        betAmount: currentServerGame.betAmount,
                        winner: currentServerGame.winner ? currentServerGame.winner.toString() : null,
                        loser: currentServerGame.loser ? currentServerGame.loser.toString() : null,
                    });
                }
            } catch (syncError) {
                console.error('Erro ao re-sincronizar cliente após erro de movimento:', syncError);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Cliente desconectado: ${socket.id}`);
    });
});

app.get('/', (req, res) => {
    res.send('Servidor BrainSkill está online!');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));