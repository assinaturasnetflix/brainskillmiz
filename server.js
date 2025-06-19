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
        origin: "*", // Permitir qualquer origem para o frontend (ajuste em produção para a URL do seu frontend)
        methods: ["GET", "POST"]
    }
});

// Importar rotas e controladores e modelos
const routes = require('./routes');
const controllers = require('./controllers'); // Importar controllers para usar as funções de lógica de jogo
const { User, Game, LobbyRoom, Setting } = require('./models'); // Importar modelos necessários

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
    tempFileDir: '/tmp/' // Diretório para armazenar arquivos temporários (necessário para alguns hosts como Render)
}));

// --- Rotas da API REST ---
app.use('/api', routes); // Prefixo '/api' para todas as rotas definidas em routes.js

// --- Lógica de Socket.IO ---
io.on('connection', socket => {
    console.log(`Novo cliente conectado: ${socket.id}`);

    // Um usuário se conecta ao lobby geral para ver as apostas
    socket.on('joinLobby', () => {
        socket.join('lobby');
        console.log(`Cliente ${socket.id} entrou no lobby.`);
        // A lista de lobbies é carregada via REST API inicialmente no frontend.
        // As atualizações globais de lobby (criação/aceitação de apostas) serão emitidas globalmente para 'lobby' room.
    });

    // Um cliente se junta a uma sala de jogo específica (ao carregar game.html, ou após aceitar aposta)
    socket.on('joinGame', async ({ gameId, userId }) => {
        if (!gameId || !userId) {
            console.error(`joinGame: gameId ou userId ausente para ${socket.id}`);
            return;
        }

        try {
            // Popula os jogadores para ter username e avatar
            const game = await Game.findById(gameId).populate('players', 'username avatar');
            if (!game) {
                console.error(`Jogo não encontrado para gameId: ${gameId}`);
                socket.emit('gameError', { message: 'Partida não encontrada.' });
                return;
            }

            // Verifica se o usuário é um dos jogadores da partida. Isso é importante para acesso.
            const isPlayer = game.players.some(p => String(p._id) === String(userId));
            if (!isPlayer) {
                console.warn(`Usuário ${userId} não é jogador da partida ${gameId}.`);
                // Poderia emitir um erro ou redirecionar o cliente se não for um jogador permitido.
                socket.emit('gameError', { message: 'Você não tem permissão para entrar nesta partida.' });
                return;
            }

            socket.join(gameId); // Adiciona o socket à sala da partida
            console.log(`Usuário ${userId} (${socket.id}) entrou/reconectou na sala do jogo: ${gameId}`);

            // SEMPRE envie o estado mais recente do jogo para o cliente que acabou de entrar/reconectar
            // Emitir APENAS para o socket que acabou de se conectar (socket.id)
            io.to(socket.id).emit('gameState', {
                boardState: game.boardState,
                currentPlayer: game.currentPlayer, // ID do MongoDB do jogador atual
                players: game.players.map(p => ({
                    id: p._id.toString(), // Mapeia _id para id para consistência no frontend
                    username: p.username,
                    avatar: p.avatar
                })),
                status: game.status,
                betAmount: game.betAmount,
                winner: game.winner ? game.winner.toString() : null,
                loser: game.loser ? game.loser.toString() : null,
            });

            // Opcional: Notificar outros jogadores na sala que um adversário entrou/reconectou
            // Só se o jogo estiver pendente e agora tiver 2 jogadores ativos, por exemplo.
            // A notificação de 'playerJoined' pode ser usada para UI "Esperando oponente..." -> "Partida Iniciada".
            // No seu caso, o 'gameState' já vai mudar o status para 'in-progress' ou 'completed'.
            // io.to(gameId).emit('playerJoined', { userId }); 

        } catch (error) {
            console.error(`Erro ao juntar-se ao jogo ${gameId}:`, error);
            socket.emit('gameError', { message: 'Erro ao entrar na partida.' });
        }
    });

    // Evento de movimento de peça (do cliente para o servidor)
    socket.on('makeMove', async ({ gameId, userId, from, to }) => {
        try {
            // Buscar o estado atual do jogo do banco de dados e popular jogadores
            let game = await Game.findById(gameId).populate('players', 'username avatar');

            if (!game || game.status !== 'in-progress') {
                socket.emit('gameError', { message: 'Partida não encontrada ou não está em andamento.' });
                return;
            }

            // Verificar se é a vez do jogador que está tentando mover
            if (String(game.currentPlayer) !== String(userId)) {
                socket.emit('gameError', { message: 'Não é a sua vez de jogar.' });
                return;
            }

            // Identificar as IDs dos jogadores da partida para determinar a cor
            const player1Id = game.players[0]._id; // Jogador 1 (Brancas)
            const player2Id = game.players[1]._id; // Jogador 2 (Pretas)
            let currentPlayerColor;

            if (String(userId) === String(player1Id)) {
                currentPlayerColor = 'white';
            } else if (String(userId) === String(player2Id)) {
                currentPlayerColor = 'black';
            } else {
                // Jogador não faz parte da partida ou ID inválido
                socket.emit('gameError', { message: 'Você não é um jogador válido desta partida.' });
                return;
            }

            // --- Lógica de Validação e Aplicação do Movimento (do controllers.js) ---
            // Importar funções de lógica de jogo dentro do escopo ou garantir que já estejam acessíveis
            const { validateMove, applyMove, checkGameEnd, getPieceColor } = controllers; 

            // Validar o movimento no backend (autoritário)
            const validationResult = validateMove(game.boardState, from, to, currentPlayerColor);

            if (!validationResult.isValid) {
                socket.emit('gameError', { message: validationResult.message });
                return;
            }

            // Aplicar o movimento ao estado do tabuleiro no objeto 'game' do servidor
            const newBoardState = applyMove(game.boardState, from, to);

            // Registrar o movimento no histórico da partida
            game.moves.push({
                player: userId,
                from: { row: from.r, col: from.c },
                to: { row: to.r, col: to.c },
                // A lista de peças capturadas aqui pode ser simplificada ou mais detalhada
                capturedPieces: validationResult.isCapture ? [`${getPieceColor(game.boardState[from.r + (to.r - from.r) / 2][from.c + (to.c - from.c) / 2])}_piece`] : [] 
            });
            game.boardState = newBoardState; // Atualiza o estado do tabuleiro no modelo

            // --- Verificar o Fim do Jogo ---
            const nextPlayerColor = currentPlayerColor === 'white' ? 'black' : 'white';
            const gameEndResult = checkGameEnd(game.boardState, nextPlayerColor);
            let winnerId = null;
            let loserId = null;

            if (gameEndResult.gameOver) {
                game.status = 'completed';
                game.completedAt = Date.now();

                // Determina o vencedor com base na regra de fim de jogo
                if (gameEndResult.winnerColor === currentPlayerColor) { // O jogador que acabou de mover venceu (ex: oponente sem peças)
                    winnerId = userId;
                    loserId = (String(player1Id) === String(userId)) ? player2Id : player1Id;
                } else { // O oponente venceu (ex: jogador atual sem movimentos válidos)
                    winnerId = (String(player1Id) === String(userId)) ? player2Id : player1Id;
                    loserId = userId;
                }

                game.winner = winnerId;
                game.loser = loserId;

                // Creditando o ganhador e aplicando comissão
                const winnerUser = await User.findById(winnerId);
                // const loserUser = await User.findById(loserId); // O saldo do perdedor já foi debitado no lobby

                const commissionSetting = await Setting.findOne({ name: 'platformCommissionRate' });
                const commissionRate = commissionSetting ? parseFloat(commissionSetting.value) : 0.10; // Padrão 10%

                const totalPot = game.betAmount * 2; // O pote total da aposta
                // O vencedor recebe o valor total da aposta do perdedor, menos a comissão sobre esse valor.
                // Ou, o valor total do pote, menos a comissão sobre o total do pote.
                // A comissão é 10% do valor ganho de um usuário em cada partida.
                // Se um usuário aposta X e ganha, ele ganha o X do outro jogador.
                // Então, a comissão é 10% de X. O ganhador recebe X + X - (X * 0.10) = 2X - 0.10X.
                // Se ele lucra X, a comissão é sobre o lucro X.
                const winnerReceives = totalPot - (game.betAmount * commissionRate); 
                
                if (winnerUser) {
                    winnerUser.balance += winnerReceives;
                    await winnerUser.save();
                    // Opcional: notificar o cliente do vencedor sobre o novo saldo
                    // io.to(String(winnerUser._id)).emit('balanceUpdate', { newBalance: winnerUser.balance });
                }

            } else {
                // Se o jogo não terminou, troca o jogador atual
                game.currentPlayer = (String(game.currentPlayer) === String(player1Id)) ? player2Id : player1Id;
            }

            await game.save(); // SALVAR O ESTADO ATUALIZADO DO JOGO NO BANCO DE DADOS

            // Emitir o novo estado do jogo para TODOS os clientes na sala da partida
            // Buscar novamente para garantir que os dados de 'winner' e 'loser' populados sejam os mais recentes
            const updatedGame = await Game.findById(gameId).populate('players', 'username avatar').populate('winner', 'username').populate('loser', 'username');

            io.to(gameId).emit('gameState', {
                boardState: updatedGame.boardState,
                currentPlayer: updatedGame.currentPlayer, // ID do próximo jogador a mover
                players: updatedGame.players.map(p => ({ // Garante que os objetos de jogador estejam formatados para o frontend
                    id: p._id.toString(),
                    username: p.username,
                    avatar: p.avatar
                })),
                status: updatedGame.status,
                betAmount: updatedGame.betAmount,
                winner: updatedGame.winner ? updatedGame.winner._id.toString() : null, // ID do vencedor
                loser: updatedGame.loser ? updatedGame.loser._id.toString() : null,   // ID do perdedor
            });

            // Se o jogo terminou, notificar o lobby e emitir um evento de 'gameEnded'
            if (updatedGame.status === 'completed' || updatedGame.status === 'cancelled') {
                await LobbyRoom.findOneAndUpdate({ gameId: updatedGame._id }, { status: 'closed' });
                io.to('lobby').emit('lobbyUpdate'); // Avisa o lobby para remover a aposta encerrada
                io.to(gameId).emit('gameEnded', { 
                    winnerId: updatedGame.winner ? updatedGame.winner._id.toString() : null, 
                    loserId: updatedGame.loser ? updatedGame.loser._id.toString() : null, 
                    reason: gameEndResult.reason || 'Partida finalizada.' 
                });
            }

        } catch (error) {
            console.error(`Erro no makeMove do jogo ${gameId}:`, error);
            // Emite um erro geral para o cliente que tentou a jogada
            socket.emit('gameError', { message: 'Erro interno ao processar o movimento. Tente novamente.' });
            
            // Opcional: Forçar o cliente a re-sincronizar o estado do jogo com o servidor
            // Isso é útil se o cliente puder ter ficado com um estado inválido após o erro.
            try {
                const currentServerGame = await Game.findById(gameId).populate('players', 'username avatar');
                if (currentServerGame) {
                    io.to(socket.id).emit('gameState', { // Emitir APENAS para o cliente que errou
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

    // Evento quando um cliente se desconecta
    socket.on('disconnect', () => {
        console.log(`Cliente desconectado: ${socket.id}`);
        // TODO: Lógica para lidar com desconexões em partidas ativas (ex: declarar vitória por abandono)
        // Isso seria mais complexo e envolveria identificar qual jogo o socket estava,
        // e se o oponente foi o único a desconectar.
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