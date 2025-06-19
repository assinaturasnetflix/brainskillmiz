// controllers.js
// Este arquivo contém toda a lógica de negócio, controladores de rota,
// lógica de jogo de damas, e gerenciamento de Socket.io para o projeto BrainSkill.

const { User, Game, Deposit, Withdrawal, LobbyRoom, PlatformSettings } = require('./models');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid'); // Para gerar códigos de recuperação de senha únicos

// --- Configurações (devem vir de variáveis de ambiente no .env) ---
const JWT_SECRET = process.env.JWT_SECRET;
const CLOUDINARY_NAME = process.env.CLOUDINARY_NAME; // Corrigido para CLOUDINARY_CLOUD_NAME
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS; // Senha de aplicativo do Google/Outlook

// Validação de variáveis de ambiente
if (!JWT_SECRET || !CLOUDINARY_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET || !EMAIL_USER || !EMAIL_PASS) {
    console.error("ERRO: Variáveis de ambiente essenciais não definidas. Verifique seu arquivo .env.");
    process.exit(1); // Encerra o aplicativo se as configurações essenciais estiverem faltando
}

// Configuração do Cloudinary
cloudinary.config({
    cloud_name: CLOUDINARY_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
});

// Configuração do Nodemailer
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", // Exemplo para Gmail, ajuste conforme seu provedor
    port: 587,
    secure: false, // true para 465, false para outras portas (como 587 TLS)
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false // Necessário para alguns hosts, mas evite em produção se possível
    }
});

// --- Middlewares de Autenticação e Autorização ---

/**
 * Middleware para proteger rotas: verifica se o token JWT é válido.
 */
const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = await User.findById(decoded.id).select('-password');

            if (!req.user) {
                return res.status(401).json({ message: 'Não autorizado, usuário não encontrado.' });
            }
            if (req.user.isBlocked) {
                return res.status(403).json({ message: 'Sua conta está bloqueada. Entre em contato com o suporte.' });
            }

            next();
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Não autorizado, token falhou.' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Não autorizado, nenhum token.' });
    }
};

/**
 * Middleware para autorizar acesso baseado em roles (ex: 'admin').
 */
const authorize = (roles = []) => {
    if (typeof roles === 'string') {
        roles = [roles];
    }

    return (req, res, next) => {
        if (!req.user || (roles.length > 0 && !roles.includes(req.user.role))) {
            return res.status(403).json({ message: 'Não autorizado para acessar esta rota.' });
        }
        next();
    };
};

// Variável global para a instância do Socket.io
let io;

/**
 * Função para inicializar a instância do Socket.io.
 * Chamado uma vez em server.js.
 */
const initializeSocketIO = (socketInstance) => {
    io = socketInstance;
    console.log('Socket.io inicializado e pronto para uso.');

    io.on('connection', (socket) => {
        console.log(`Novo cliente conectado: ${socket.id}`);

        // Evento para um usuário entrar em uma sala de usuário específica
        socket.on('joinUserRoom', async ({ userId, token }) => {
            try {
                if (!token) {
                    socket.emit('authError', { message: 'Autenticação falhou: Token não fornecido.' });
                    return;
                }
                const decoded = jwt.verify(token, JWT_SECRET);
                if (decoded.id !== userId) {
                     socket.emit('authError', { message: 'Autenticação falhou: ID de usuário não corresponde.' });
                     return;
                }
                const user = await User.findById(decoded.id).select('-password');
                if (!user || user.isBlocked) {
                    socket.emit('authError', { message: 'Autenticação falhou: Usuário não encontrado ou bloqueado.' });
                    return;
                }
                socket.join(userId); // Junta o socket à sala do seu próprio ID de usuário
                console.log(`Usuário ${user.username} (${user._id}) entrou na sala pessoal.`);
            } catch (error) {
                console.error('Erro ao juntar-se à sala do usuário:', error);
                socket.emit('authError', { message: 'Falha na autenticação do usuário para sala pessoal.' });
            }
        });


        socket.on('disconnect', () => {
            console.log(`Cliente desconectado: ${socket.id}`);
            // Lógica para lidar com desconexão de jogadores em partidas ativas
            // Quando um jogador desconecta durante uma partida, o outro vence por WO.
            // Para implementar isso, você precisaria de um mapa de socket.id para gameId
            // e userId. Poderíamos adicionar isso a um "TODO" mais tarde se o tempo permitir.
        });

        // Evento para um usuário entrar em uma sala de jogo específica
        socket.on('joinGameRoom', async ({ gameId, token }) => {
            try {
                if (!token) {
                    socket.emit('authError', { message: 'Token de autenticação ausente.' });
                    return;
                }
                const decoded = jwt.verify(token, JWT_SECRET);
                const user = await User.findById(decoded.id).select('-password');
                if (!user || user.isBlocked) {
                    socket.emit('authError', { message: 'Usuário não autenticado ou bloqueado.' });
                    return;
                }

                const game = await Game.findById(gameId);
                if (!game) {
                    socket.emit('gameError', { message: 'Partida não encontrada.' });
                    return;
                }

                const isPlayer = game.players.some(p => p.userId.equals(user._id));
                if (!isPlayer) {
                    socket.emit('gameError', { message: 'Você não é um jogador nesta partida.' });
                    return;
                }

                // Verifica se o usuário já está na sala do jogo
                const rooms = io.sockets.adapter.sids.get(socket.id);
                if (rooms && rooms.has(gameId.toString())) {
                    console.log(`Usuário ${user.username} já está na sala de jogo ${gameId}`);
                    socket.emit('joinedGameRoom', { gameId, message: 'Você já está na sala da partida.' });
                    // Envia o estado atual do jogo para o participante que já está na sala
                    io.to(gameId).emit('gameStateUpdate', {
                        gameId: game._id,
                        boardState: JSON.parse(game.boardState),
                        currentPlayer: game.currentPlayer,
                        status: game.status,
                        players: await Promise.all(game.players.map(async p => {
                            const pUser = await User.findById(p.userId);
                            return { username: p.username, color: p.color, avatar: pUser ? pUser.avatar : null };
                        }))
                    });
                    return;
                }


                socket.join(gameId.toString()); // Junta o socket à sala do gameId
                console.log(`Usuário ${user.username} (${user._id}) entrou na sala de jogo ${gameId}`);
                socket.emit('joinedGameRoom', { gameId, message: 'Você entrou na sala da partida.' });

                // Envia o estado atual do jogo para todos na sala (incluindo o novo participante)
                io.to(gameId.toString()).emit('gameStateUpdate', {
                    gameId: game._id,
                    boardState: JSON.parse(game.boardState),
                    currentPlayer: game.currentPlayer,
                    status: game.status,
                    players: await Promise.all(game.players.map(async p => {
                        const pUser = await User.findById(p.userId);
                        return { username: p.username, color: p.color, avatar: pUser ? pUser.avatar : null };
                    }))
                });


            } catch (error) {
                console.error('Erro ao juntar-se à sala de jogo:', error);
                socket.emit('gameError', { message: 'Erro ao entrar na sala da partida.', error: error.message });
            }
        });

        // Evento para uma jogada
        socket.on('makeMove', async ({ gameId, move, token }) => {
            try {
                if (!token) {
                    socket.emit('authError', { message: 'Token de autenticação ausente.' });
                    return;
                }
                const decoded = jwt.verify(token, JWT_SECRET);
                const user = await User.findById(decoded.id).select('-password');
                if (!user || user.isBlocked) {
                    socket.emit('authError', { message: 'Usuário não autenticado ou bloqueado.' });
                    return;
                }

                const game = await Game.findById(gameId);
                if (!game || game.status !== 'in-progress') {
                    socket.emit('moveError', { message: 'Partida não encontrada ou não está em andamento.' });
                    return;
                }

                const playerInGame = game.players.find(p => p.userId.equals(user._id));
                if (!playerInGame) {
                    socket.emit('moveError', { message: 'Você não é um jogador nesta partida.' });
                    return;
                }

                const currentPlayerColor = game.currentPlayer;
                if (playerInGame.color !== currentPlayerColor) {
                    socket.emit('moveError', { message: 'Não é sua vez de jogar.' });
                    return;
                }

                let currentBoard = JSON.parse(game.boardState);
                const fromCoord = move.from;
                const toCoord = move.to;

                const validationResult = validateAndApplyMove(currentBoard, fromCoord, toCoord, currentPlayerColor);

                if (!validationResult.isValid) {
                    socket.emit('moveError', { message: validationResult.message });
                    return;
                }

                game.boardState = JSON.stringify(validationResult.newBoard);
                game.moves.push({ player: user._id, from: fromCoord, to: toCoord, capturedPieces: validationResult.capturedPieces });

                let gameEnded = false;
                let winnerUser = null;
                let loserUser = null;

                const opponentColor = currentPlayerColor === 'white' ? 'black' : 'white';
                const opponentPlayer = game.players.find(p => p.color === opponentColor);

                // Re-verificar peças do oponente e movimentos válidos
                const remainingPiecesOpponent = countPieces(validationResult.newBoard, opponentColor);
                const opponentHasValidMoves = checkHasValidMoves(validationResult.newBoard, opponentColor);

                if (remainingPiecesOpponent === 0 || !opponentHasValidMoves) {
                    gameEnded = true;
                    winnerUser = user;
                    loserUser = await User.findById(opponentPlayer.userId);
                    game.status = 'completed';
                    game.winner = winnerUser._id;
                    game.loser = loserUser._id;
                    game.endTime = new Date();
                } else {
                    game.currentPlayer = opponentColor; // Troca o turno
                }

                await game.save();

                io.to(gameId.toString()).emit('gameStateUpdate', {
                    gameId: game._id,
                    boardState: JSON.parse(game.boardState),
                    currentPlayer: game.currentPlayer,
                    status: game.status,
                    players: await Promise.all(game.players.map(async p => {
                        const pUser = await User.findById(p.userId);
                        return { username: p.username, color: p.color, avatar: pUser ? pUser.avatar : null };
                    }))
                });

                if (gameEnded && winnerUser && loserUser) {
                    const platformSettings = await PlatformSettings.findOne();
                    const commissionRate = platformSettings ? platformSettings.commissionRate : 0.10;

                    const winnerGrossGain = game.betAmount; // O que o vencedor recebe do adversário
                    const platformCommission = winnerGrossGain * commissionRate;
                    const winnerNetGain = winnerGrossGain - platformCommission;

                    winnerUser.balance += winnerGrossGain; // Adiciona o valor apostado pelo perdedor
                    winnerUser.totalWins += 1;
                    winnerUser.totalGames += 1;
                    winnerUser.platformCommissionEarned += platformCommission;

                    loserUser.balance -= game.betAmount;
                    loserUser.totalLosses += 1;
                    loserUser.totalGames += 1;

                    await winnerUser.save();
                    await loserUser.save();

                    io.to(gameId.toString()).emit('gameOver', {
                        winner: { userId: winnerUser._id, username: winnerUser.username },
                        loser: { userId: loserUser._id, username: loserUser.username },
                        betAmount: game.betAmount,
                        winnerNetGain: winnerNetGain, // Envia o ganho líquido
                        platformCommission: platformCommission,
                        message: `${winnerUser.username} venceu a partida e ganhou ${winnerNetGain.toFixed(2)} MT!`
                    });
                    
                    io.to(winnerUser._id.toString()).emit('balanceUpdate', {
                        newBalance: winnerUser.balance,
                        message: `Seu saldo foi atualizado! Você ganhou ${winnerNetGain.toFixed(2)} MT.`
                    });
                    io.to(loserUser._id.toString()).emit('balanceUpdate', {
                        newBalance: loserUser.balance,
                        message: `Seu saldo foi atualizado! Você perdeu ${game.betAmount} MT.`
                    });

                    if (game.lobbyId) {
                        await LobbyRoom.findByIdAndUpdate(game.lobbyId, { status: 'closed' });
                    }
                }

            } catch (error) {
                console.error('Erro ao fazer jogada:', error);
                socket.emit('moveError', { message: 'Erro interno ao processar a jogada.', error: error.message });
            }
        });

        // Evento para desistência
        socket.on('forfeitGame', async ({ gameId, token }) => {
            try {
                if (!token) {
                    socket.emit('authError', { message: 'Token de autenticação ausente.' });
                    return;
                }
                const decoded = jwt.verify(token, JWT_SECRET);
                const user = await User.findById(decoded.id).select('-password');
                if (!user || user.isBlocked) {
                    socket.emit('authError', { message: 'Usuário não autenticado ou bloqueado.' });
                    return;
                }

                const game = await Game.findById(gameId);
                if (!game || game.status !== 'in-progress') {
                    socket.emit('gameError', { message: 'Partida não encontrada ou já encerrada.' });
                    return;
                }

                const forfeitingPlayer = game.players.find(p => p.userId.equals(user._id));
                if (!forfeitingPlayer) {
                    socket.emit('gameError', { message: 'Você não é um jogador nesta partida.' });
                    return;
                }

                const winnerPlayer = game.players.find(p => !p.userId.equals(user._id));
                const winnerUser = await User.findById(winnerPlayer.userId);
                
                // Atualiza o status do jogo
                game.status = 'completed';
                game.winner = winnerUser._id;
                game.loser = user._id; // O desistente é o perdedor
                game.endTime = new Date();
                await game.save();

                // Processa os saldos (o desistente perde o valor da aposta)
                const platformSettings = await PlatformSettings.findOne();
                const commissionRate = platformSettings ? platformSettings.commissionRate : 0.10;

                const winnerGrossGain = game.betAmount;
                const platformCommission = winnerGrossGain * commissionRate;
                const winnerNetGain = winnerGrossGain - platformCommission;

                winnerUser.balance += winnerGrossGain;
                winnerUser.totalWins += 1;
                winnerUser.totalGames += 1;
                winnerUser.platformCommissionEarned += platformCommission;

                user.balance -= game.betAmount; // Desistente perde o valor apostado
                user.totalLosses += 1;
                user.totalGames += 1;

                await winnerUser.save();
                await user.save();

                // Notifica ambos os jogadores sobre a desistência e o resultado
                io.to(gameId.toString()).emit('gameOver', {
                    winner: { userId: winnerUser._id, username: winnerUser.username },
                    loser: { userId: user._id, username: user.username },
                    betAmount: game.betAmount,
                    winnerNetGain: winnerNetGain,
                    platformCommission: platformCommission,
                    message: `${user.username} desistiu! ${winnerUser.username} venceu e ganhou ${winnerNetGain.toFixed(2)} MT!`
                });

                io.to(winnerUser._id.toString()).emit('balanceUpdate', {
                    newBalance: winnerUser.balance,
                    message: `Seu saldo foi atualizado! Você ganhou ${winnerNetGain.toFixed(2)} MT por WO.`
                });
                io.to(user._id.toString()).emit('balanceUpdate', {
                    newBalance: user.balance,
                    message: `Seu saldo foi atualizado! Você perdeu ${game.betAmount} MT por desistência.`
                });

                if (game.lobbyId) {
                    await LobbyRoom.findByIdAndUpdate(game.lobbyId, { status: 'closed' });
                }

                // Acknowledge the forfeit request to the client who initiated it
                socket.emit('forfeitGameAcknowledged', { winnerUsername: winnerUser.username });


            } catch (error) {
                console.error('Erro ao desistir da partida:', error);
                socket.emit('gameError', { message: 'Erro ao processar desistência.', error: error.message });
            }
        });
    });
};

// --- Funções Auxiliares para o Jogo de Damas ---
// Representação do tabuleiro: array 8x8.
// ' ' = vazio, 'w' = peça branca, 'b' = peça preta,
// 'W' = dama branca, 'B' = dama preta.
const initialBoardState = [
    [' ', 'b', ' ', 'b', ' ', 'b', ' ', 'b'],
    ['b', ' ', 'b', ' ', 'b', ' ', 'b', ' '],
    [' ', 'b', ' ', 'b', ' ', 'b', ' ', 'b'],
    [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
    [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
    ['w', ' ', 'w', ' ', 'w', ' ', 'w', ' '],
    [' ', 'w', ' ', 'w', ' ', 'w', ' ', 'w'],
    ['w', ' ', 'w', ' ', 'w', ' ', 'w', ' ']
];

// Mapeia coordenadas como 'a1' para [linha, coluna]
const coordToRowCol = (coord) => {
    const col = coord.charCodeAt(0) - 'a'.charCodeAt(0);
    const row = 8 - parseInt(coord[1], 10);
    return [row, col];
};

const rowColToCoord = (row, col) => {
    const char = String.fromCharCode('a'.charCodeAt(0) + col);
    const num = 8 - row;
    return `${char}${num}`;
};

// Função para verificar se uma posição está dentro do tabuleiro
const isValidPosition = (row, col) => {
    return row >= 0 && row < 8 && col >= 0 && col < 8;
};

// Função para obter a peça em uma determinada posição
const getPiece = (board, row, col) => {
    if (!isValidPosition(row, col)) return null;
    return board[row][col];
};

// Função para contar peças de uma cor no tabuleiro
const countPieces = (board, color) => {
    let count = 0;
    const targetPieces = color === 'white' ? ['w', 'W'] : ['b', 'B'];
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (targetPieces.includes(board[r][c])) {
                count++;
            }
        }
    }
    return count;
};

// Função para verificar se um jogador tem movimentos válidos
const checkHasValidMoves = (board, playerColor) => {
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = getPiece(board, r, c);
            const isCurrentPlayerPiece = (playerColor === 'white' && (piece === 'w' || piece === 'W')) ||
                                         (playerColor === 'black' && (piece === 'b' || piece === 'B'));
            if (isCurrentPlayerPiece) {
                // Primeiro, verifica se há *qualquer* captura disponível
                const pieceCaptures = findCapturesForPiece(board, r, c, playerColor);
                if (pieceCaptures.length > 0) return true; // Se há uma captura, há um movimento válido

                // Se não há captura, verifica movimentos normais (para peões)
                if (piece === 'w' || piece === 'b') { // É um peão
                    const forwardDir = (playerColor === 'white') ? -1 : 1; // Brancas sobem (-1), Pretas descem (+1)
                    const diagonalCols = [-1, 1];
                    for (const dc of diagonalCols) {
                        const newRow = r + forwardDir;
                        const newCol = c + dc;
                        if (isValidPosition(newRow, newCol) && getPiece(board, newRow, newCol) === ' ') {
                            return true; // Movimento normal possível
                        }
                    }
                }
                // Para damas, é mais complexo e pode ter movimentos longos
                if (piece === 'W' || piece === 'B') { // É uma dama
                    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
                    for (const [dr, dc] of directions) {
                        for (let step = 1; step < 8; step++) {
                            const newRow = r + dr * step;
                            const newCol = c + dc * step;
                            if (!isValidPosition(newRow, newCol)) break;
                            if (getPiece(board, newRow, newCol) === ' ') {
                                return true; // Movimento normal de dama possível
                            }
                            // Se encontrar uma peça, não pode ir além nesse caminho (apenas captura)
                            break;
                        }
                    }
                }
            }
        }
    }
    return false; // Nenhum movimento válido encontrado
};

// Auxiliar para encontrar todas as possíveis capturas para UMA PEÇA específica
const findCapturesForPiece = (board, r, c, playerColor) => {
    const captures = [];
    const piece = getPiece(board, r, c);
    const isKing = (piece === 'W' || piece === 'B');
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]]; // DR, DC

    for (const [dr, dc] of directions) {
        if (!isKing && playerColor === 'white' && dr > 0) continue; // Peão branco só captura para frente
        if (!isKing && playerColor === 'black' && dr < 0) continue; // Peão preto só captura para frente

        const opponentRow = r + dr;
        const opponentCol = c + dc;
        const landingRow = r + 2 * dr;
        const landingCol = c + 2 * dc;

        if (isValidPosition(landingRow, landingCol) && getPiece(board, landingRow, landingCol) === ' ') {
            const opponentPiece = getPiece(board, opponentRow, opponentCol);
            const isOpponentPiece = (playerColor === 'white' && (opponentPiece === 'b' || opponentPiece === 'B')) ||
                                   (playerColor === 'black' && (opponentPiece === 'w' || opponentPiece === 'W'));
            if (isOpponentPiece) {
                captures.push({ from: rowColToCoord(r, c), to: rowColToCoord(landingRow, landingCol), captured: rowColToCoord(opponentRow, opponentCol) });
            }
        }

        // Lógica de captura para Dama (salto longo)
        if (isKing) {
            let foundOpponentInPath = false;
            let currentR = r + dr;
            let currentC = c + dc;

            while (isValidPosition(currentR, currentC)) {
                const pathPiece = getPiece(board, currentR, currentC);
                const isOpponentPiece = (playerColor === 'white' && (pathPiece === 'b' || pathPiece === 'B')) ||
                                       (playerColor === 'black' && (pathPiece === 'w' || pathPiece === 'W'));
                const isOwnPiece = (playerColor === 'white' && (pathPiece === 'w' || pathPiece === 'W')) ||
                                  (playerColor === 'black' && (pathPiece === 'b' || pathPiece === 'B'));

                if (isOwnPiece) break; // Bloqueado por peça própria
                if (pathPiece !== ' ' && isOpponentPiece) {
                    if (foundOpponentInPath) break; // Já encontrou uma peça inimiga (não pode saltar sobre duas)
                    foundOpponentInPath = true;
                    // Próxima casa DEPOIS da peça inimiga precisa estar vazia
                    const landingR = currentR + dr;
                    const landingC = currentC + dc;
                    if (isValidPosition(landingR, landingC) && getPiece(board, landingR, landingC) === ' ') {
                        // A dama pode capturar e parar em qualquer casa vazia APÓS a peça capturada
                        for (let k = 0; k < 8; k++) { // Max 8 casas de distancia
                            const finalLandingR = currentR + dr * (k + 1);
                            const finalLandingC = currentC + dc * (k + 1);
                            if (!isValidPosition(finalLandingR, finalLandingC) || getPiece(board, finalLandingR, finalLandingC) !== ' ') break;
                            captures.push({ from: rowColToCoord(r, c), to: rowColToCoord(finalLandingR, finalLandingC), captured: rowColToCoord(currentR, currentC) });
                        }
                    }
                    break; // Após encontrar e processar a captura, este caminho está feito.
                }
                currentR += dr;
                currentC += dc;
            }
        }
    }
    return captures;
};


/**
 * Valida e aplica uma jogada no tabuleiro.
 * Retorna { isValid: boolean, message: string, newBoard: array, capturedPieces: array }
 */
const validateAndApplyMove = (board, fromCoord, toCoord, currentPlayerColor) => {
    const [fromRow, fromCol] = coordToRowCol(fromCoord);
    const [toRow, toCol] = coordToRowCol(toCoord);

    const piece = getPiece(board, fromRow, fromCol);
    if (!piece) {
        return { isValid: false, message: 'Nenhuma peça na posição de origem.' };
    }

    const isCurrentPlayerPiece = (currentPlayerColor === 'white' && (piece === 'w' || piece === 'W')) ||
                                 (currentPlayerColor === 'black' && (piece === 'b' || piece === 'B'));

    if (!isCurrentPlayerPiece) {
        return { isValid: false, message: 'A peça selecionada não pertence ao jogador atual.' };
    }

    let newBoard = JSON.parse(JSON.stringify(board));
    let capturedPieces = [];

    const isKing = (piece === 'W' || piece === 'B');
    const rowDiff = toRow - fromRow;
    const colDiff = toCol - fromCol;

    if (Math.abs(rowDiff) !== Math.abs(colDiff) || Math.abs(rowDiff) === 0) {
        return { isValid: false, message: 'Movimento inválido: peças de dama movem-se apenas na diagonal.' };
    }

    // --- Lógica de Captura Obrigatória ---
    const allPossibleCaptures = findAllPossibleCaptures(newBoard, currentPlayerColor);
    const isCaptureAvailable = allPossibleCaptures.length > 0;
    let isCurrentMoveACapture = false;

    // Check if the current move is a valid capture (for peão or dama)
    const currentMovePotentialCaptures = findCapturesForMove(newBoard, fromRow, fromCol, toRow, toCol, currentPlayerColor);
    if (currentMovePotentialCaptures.length > 0) {
        isCurrentMoveACapture = true;
        // Remove captured piece(s) from the board copy
        currentMovePotentialCaptures.forEach(capturedCoord => {
            const [cRow, cCol] = coordToRowCol(capturedCoord);
            newBoard[cRow][cCol] = ' ';
            capturedPieces.push(capturedCoord);
        });
    }

    // Rule: if capture is available, a non-capture move is invalid
    if (isCaptureAvailable && !isCurrentMoveACapture) {
        return { isValid: false, message: 'Captura obrigatória não realizada. Você deve capturar uma peça.' };
    }

    // If it's a capture move, it must be valid according to the piece type
    if (isCurrentMoveACapture) {
        // Move the piece
        newBoard[toRow][toCol] = piece;
        newBoard[fromRow][fromCol] = ' ';
    } else { // It's a normal move (no capture)
        if (Math.abs(rowDiff) !== 1) {
            return { isValid: false, message: 'Movimento inválido: Peões só movem uma casa sem captura.' };
        }
        if (!isKing) { // Peão
            const forwardDir = (currentPlayerColor === 'white') ? -1 : 1;
            if (rowDiff !== forwardDir) {
                return { isValid: false, message: 'Peões só podem mover para frente (sem captura).' };
            }
        }
        // Apply the normal move
        newBoard[toRow][toCol] = piece;
        newBoard[fromRow][fromCol] = ' ';
    }

    // Após a jogada (movimento ou captura), verifica se o peão virou dama
    if (!isKing) { // Se a peça era um peão
        if ((currentPlayerColor === 'white' && toRow === 0) || (currentPlayerColor === 'black' && toRow === 7)) {
            newBoard[toRow][toCol] = currentPlayerColor === 'white' ? 'W' : 'B'; // Promove para Dama
        }
    }

    // TODO: Implementar a regra de "maior número de peças" para captura obrigatória
    // Isso é complexo e geralmente envolve um algoritmo de busca (ex: minimax ou BFS/DFS)
    // para encontrar a sequência de captura que resulta no maior número de peças capturadas.
    // Se o movimento atual é uma captura, você precisaria verificar se é a "melhor" captura.
    // Por enquanto, aceitamos qualquer captura válida.

    return { isValid: true, message: 'Jogada válida.', newBoard, capturedPieces };
};

// Auxiliar para a Dama: Obtém todos os pontos no caminho diagonal
const getPath = (r1, c1, r2, c2) => {
    const path = [];
    const dr = (r2 > r1) ? 1 : -1;
    const dc = (c2 > c1) ? 1 : -1;

    let r = r1 + dr;
    let c = c1 + dc;

    while (r !== r2 || c !== c2) { // Inclui o ponto final no path para verificar se está vazio
        if (!isValidPosition(r, c)) break; // Evita loop infinito se caminho for inválido
        path.push([r, c]);
        r += dr;
        c += dc;
    }
    return path;
};

// Auxiliar para encontrar todas as possíveis capturas para um jogador.
// Aprimorado para considerar Dama corretamente
const findAllPossibleCaptures = (board, playerColor) => {
    const captures = [];
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = getPiece(board, r, c);
            const isCurrentPlayerPiece = (playerColor === 'white' && (piece === 'w' || piece === 'W')) ||
                                         (playerColor === 'black' && (piece === 'b' || piece === 'B'));

            if (isCurrentPlayerPiece) {
                const pieceCaptures = findCapturesForPiece(board, r, c, playerColor);
                captures.push(...pieceCaptures);
            }
        }
    }
    return captures;
};


// Auxiliar para verificar se uma jogada específica é uma captura (retorna capturas para ESSA jogada)
const findCapturesForMove = (board, fromRow, fromCol, toRow, toCol, currentPlayerColor) => {
    const capturedPiecesCoords = [];
    const piece = getPiece(board, fromRow, fromCol);
    const isKing = (piece === 'W' || piece === 'B');

    const rowDiff = toRow - fromRow;
    const colDiff = toCol - fromCol;

    if (Math.abs(rowDiff) === 0 || Math.abs(rowDiff) !== Math.abs(colDiff)) {
        return []; // Não é uma diagonal ou não há movimento
    }

    if (!isKing) { // Peão
        if (Math.abs(rowDiff) === 2) { // Deve ser um salto de 2 casas
            const capturedRow = fromRow + (rowDiff / 2);
            const capturedCol = fromCol + (colDiff / 2);
            const capturedPiece = getPiece(board, capturedRow, capturedCol);
            const isOpponentPiece = (currentPlayerColor === 'white' && (capturedPiece === 'b' || capturedPiece === 'B')) ||
                                   (currentPlayerColor === 'black' && (capturedPiece === 'w' || capturedPiece === 'W'));
            if (isOpponentPiece) {
                capturedPiecesCoords.push(rowColToCoord(capturedRow, capturedCol));
            }
        }
    } else { // Dama
        const path = getPath(fromRow, fromCol, toRow, toCol); // Caminho sem incluir a origem
        let piecesInPath = 0;
        let potentialCapturedCoord = null;

        for (const [r, c] of path) {
            if (r === toRow && c === toCol) break; // Não contar o destino como peça no caminho
            const p = getPiece(board, r, c);
            if (p !== ' ') {
                piecesInPath++;
                const isOpponentPiece = (currentPlayerColor === 'white' && (p === 'b' || p === 'B')) ||
                                       (currentPlayerColor === 'black' && (p === 'w' || p === 'W'));
                if (isOpponentPiece) {
                    potentialCapturedCoord = rowColToCoord(r, c);
                } else { // É uma peça do próprio jogador no caminho
                    return []; // Caminho bloqueado
                }
            }
        }

        if (piecesInPath === 1 && potentialCapturedCoord) {
            // A casa de destino deve estar vazia. Isso já é verificado em validateAndApplyMove.
            // Aqui só confirmamos que tem uma peça inimiga no caminho e a casa de destino está DEPOIS dela.
            // O caminho obtido por getPath já exclui a origem e inclui o destino.
            // A casa da peça capturada é a penúltima antes do destino se for um salto de uma peça.
            capturedPiecesCoords.push(potentialCapturedCoord);
        }
    }
    return capturedPiecesCoords;
};

// --- Fim das Funções Auxiliares de Jogo ---


// --- Controladores de Autenticação e Usuário ---

/**
 * @desc Registrar um novo usuário
 * @route POST /api/auth/register
 * @access Public
 */
const registerUser = async (req, res) => {
    const { username, email, password, mPesaNumber, eMolaNumber } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ message: 'Por favor, insira todos os campos obrigatórios: username, email e password.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ message: 'A senha deve ter pelo menos 6 caracteres.' });
    }

    try {
        let user = await User.findOne({ $or: [{ email }, { username }] });
        if (user) {
            return res.status(400).json({ message: 'Usuário ou e-mail já registrado.' });
        }

        user = await User.create({
            username,
            email,
            password,
            mPesaNumber: mPesaNumber || undefined,
            eMolaNumber: eMolaNumber || undefined,
        });

        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });

        res.status(201).json({
            message: 'Usuário registrado com sucesso!',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                balance: user.balance,
                role: user.role,
                mPesaNumber: user.mPesaNumber,
                eMolaNumber: user.eMolaNumber,
            },
            token,
        });

    } catch (error) {
        console.error('Erro no registro de usuário:', error);
        res.status(500).json({ message: 'Erro no servidor ao registrar usuário.' });
    }
};

/**
 * @desc Autenticar usuário e obter token
 * @route POST /api/auth/login
 * @access Public
 */
const loginUser = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Por favor, insira e-mail e senha.' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ message: 'Credenciais inválidas.' });
        }

        if (user.isBlocked) {
            return res.status(403).json({ message: 'Sua conta está bloqueada. Entre em contato com o suporte.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Credenciais inválidas.' });
        }

        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });

        res.status(200).json({
            message: 'Login realizado com sucesso!',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                balance: user.balance,
                role: user.role,
                mPesaNumber: user.mPesaNumber,
                eMolaNumber: user.eMolaNumber,
                totalWins: user.totalWins,
                totalLosses: user.totalLosses,
                totalGames: user.totalGames,
                platformCommissionEarned: user.platformCommissionEarned
            },
            token,
        });

    } catch (error) {
        console.error('Erro no login de usuário:', error);
        res.status(500).json({ message: 'Erro no servidor ao fazer login.' });
    }
};

/**
 * @desc Solicitar recuperação de senha (envia código por email)
 * @route POST /api/auth/forgot-password
 * @access Public
 */
const forgotPassword = async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Por favor, insira seu e-mail.' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(200).json({ message: 'Se o e-mail estiver registrado, um código de recuperação será enviado.' });
        }

        const resetCode = uuidv4().substring(0, 6).toUpperCase();
        const resetExpires = Date.now() + 10 * 60 * 1000;

        user.passwordResetCode = resetCode;
        user.passwordResetExpires = resetExpires;
        await user.save();

        const platformSettings = await PlatformSettings.findOne();
        const platformName = platformSettings ? platformSettings.platformName : "BrainSkill";

        const mailOptions = {
            from: `"${platformName} Support" <${EMAIL_USER}>`,
            to: user.email,
            subject: `[${platformName}] Código de Recuperação de Senha`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
                    <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
                        <h1 style="margin: 0;">${platformName}</h1>
                    </div>
                    <div style="padding: 20px;">
                        <p>Olá ${user.username},</p>
                        <p>Recebemos uma solicitação de recuperação de senha para sua conta.</p>
                        <p>Seu código de recuperação é:</p>
                        <h2 style="background-color: #f2f2f2; padding: 10px; text-align: center; border-radius: 5px; letter-spacing: 5px;">
                            <strong>${resetCode}</strong>
                        </h2>
                        <p>Este código é válido por <strong>10 minutos</strong>. Não o compartilhe com ninguém.</p>
                        <p>Se você não solicitou esta recuperação, por favor, ignore este e-mail.</p>
                        <p>Atenciosamente,<br>A Equipe ${platformName}</p>
                    </div>
                    <div style="background-color: #f0f0f0; color: #777; padding: 15px; text-align: center; font-size: 0.8em;">
                        <p>&copy; ${new Date().getFullYear()} ${platformName}. Todos os direitos reservados.</p>
                    </div>
                </div>
            `,
        };

        await transporter.sendMail(mailOptions);

        res.status(200).json({ message: 'Código de recuperação enviado para o seu e-mail.' });

    } catch (error) {
        console.error('Erro ao enviar e-mail de recuperação:', error);
        res.status(500).json({ message: 'Erro no servidor ao solicitar recuperação de senha.' });
    }
};

/**
 * @desc Redefinir senha usando o código
 * @route POST /api/auth/reset-password
 * @access Public
 */
const resetPassword = async (req, res) => {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
        return res.status(400).json({ message: 'Por favor, forneça e-mail, código e a nova senha.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ message: 'A nova senha deve ter pelo menos 6 caracteres.' });
    }

    try {
        const user = await User.findOne({
            email,
            passwordResetCode: code,
            passwordResetExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ message: 'Código de recuperação inválido ou expirado.' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.passwordResetCode = undefined;
        user.passwordResetExpires = undefined;
        await user.save();

        res.status(200).json({ message: 'Senha redefinida com sucesso!' });

    } catch (error) {
        console.error('Erro ao redefinir senha:', error);
        res.status(500).json({ message: 'Erro no servidor ao redefinir senha.' });
    }
};

/**
 * @desc Obter perfil do usuário logado
 * @route GET /api/users/profile
 * @access Private
 */
const getUserProfile = async (req, res) => {
    try {
        const user = req.user;

        res.status(200).json({
            id: user._id,
            username: user.username,
            email: user.email,
            avatar: user.avatar,
            balance: user.balance,
            role: user.role,
            mPesaNumber: user.mPesaNumber,
            eMolaNumber: user.eMolaNumber,
            totalWins: user.totalWins,
            totalLosses: user.totalLosses,
            totalGames: user.totalGames,
            platformCommissionEarned: user.platformCommissionEarned
        });

    } catch (error) {
        console.error('Erro ao obter perfil do usuário:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter perfil.' });
    }
};

/**
 * @desc Atualizar perfil do usuário logado
 * @route PUT /api/users/profile
 * @access Private
 */
const updateUserProfile = async (req, res) => {
    const { username, email, mPesaNumber, eMolaNumber, newPassword } = req.body;

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (username && username !== user.username) {
            const usernameExists = await User.findOne({ username });
            if (usernameExists && !usernameExists._id.equals(user._id)) {
                return res.status(400).json({ message: 'Nome de usuário já em uso.' });
            }
            user.username = username;
        }
        if (email && email !== user.email) {
            const emailExists = await User.findOne({ email });
            if (emailExists && !emailExists._id.equals(user._id)) {
                return res.status(400).json({ message: 'E-mail já em uso.' });
            }
            user.email = email;
        }
        if (mPesaNumber !== undefined) {
            user.mPesaNumber = mPesaNumber;
        }
        if (eMolaNumber !== undefined) {
            user.eMolaNumber = eMolaNumber;
        }
        if (newPassword) {
            if (newPassword.length < 6) {
                return res.status(400).json({ message: 'A nova senha deve ter pelo menos 6 caracteres.' });
            }
            user.password = newPassword;
        }

        await user.save();

        res.status(200).json({
            message: 'Perfil atualizado com sucesso!',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                balance: user.balance,
                role: user.role,
                mPesaNumber: user.mPesaNumber,
                eMolaNumber: user.eMolaNumber,
            }
        });

    } catch (error) {
        console.error('Erro ao atualizar perfil do usuário:', error);
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Username ou e-mail já em uso por outra conta.' });
        }
        res.status(500).json({ message: 'Erro no servidor ao atualizar perfil.' });
    }
};

/**
 * @desc Upload de avatar para o usuário logado
 * @route POST /api/users/profile/avatar
 * @access Private
 */
const uploadAvatar = async (req, res) => {
    try {
        let imageUrl = req.body.imageUrl;
        const imageData = req.body.imageData;

        if (!imageUrl && !imageData) {
            return res.status(400).json({ message: 'Nenhuma imagem fornecida para upload.' });
        }

        if (imageData) {
            const result = await cloudinary.uploader.upload(imageData, {
                folder: 'brainskill_avatars',
                width: 150,
                height: 150,
                crop: 'fill'
            });
            imageUrl = result.secure_url;
        } else if (imageUrl && !imageUrl.startsWith('http')) {
            return res.status(400).json({ message: 'URL de imagem inválida.' });
        }

        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        user.avatar = imageUrl;
        await user.save();

        res.status(200).json({ message: 'Avatar atualizado com sucesso!', avatar: user.avatar });

    } catch (error) {
        console.error('Erro ao fazer upload de avatar:', error);
        res.status(500).json({ message: 'Erro no servidor ao fazer upload de avatar.', error: error.message });
    }
};

/**
 * @desc Obter ranking de jogadores (perfis visíveis)
 * @route GET /api/users/ranking
 * @access Public
 */
const getRanking = async (req, res) => {
    try {
        const ranking = await User.find({ role: 'user', isBlocked: false })
            .select('username avatar totalWins totalLosses totalGames balance')
            .sort({ totalWins: -1, totalGames: -1, balance: -1 })
            .limit(50);

        res.status(200).json(ranking);

    } catch (error) {
        console.error('Erro ao obter ranking:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter ranking.' });
    }
};


// --- Controladores de Transações (Depósito e Levantamento) ---

/**
 * @desc Solicitar um depósito
 * @route POST /api/transactions/deposit
 * @access Private
 */
const requestDeposit = async (req, res) => {
    const { amount, method, phoneNumber } = req.body;

    if (!amount || !method || !phoneNumber) {
        return res.status(400).json({ message: 'Por favor, forneça o valor, método (M-Pesa/e-Mola) e número de telefone.' });
    }
    if (amount <= 0) {
        return res.status(400).json({ message: 'O valor do depósito deve ser positivo.' });
    }
    if (!['M-Pesa', 'e-Mola'].includes(method)) {
        return res.status(400).json({ message: 'Método de depósito inválido. Use "M-Pesa" ou "e-Mola".' });
    }

    try {
        const platformSettings = await PlatformSettings.findOne();
        const minDeposit = platformSettings ? platformSettings.minDeposit : 50;
        const maxDeposit = platformSettings ? platformSettings.maxDeposit : 5000;

        if (amount < minDeposit || amount > maxDeposit) {
            return res.status(400).json({ message: `O valor do depósito deve estar entre ${minDeposit} MT e ${maxDeposit} MT.` });
        }

        const deposit = await Deposit.create({
            userId: req.user._id,
            amount,
            method,
            phoneNumber,
            status: 'pending'
        });

        res.status(201).json({
            message: 'Solicitação de depósito enviada com sucesso! Aguardando aprovação.',
            depositId: deposit._id,
            status: deposit.status
        });

    } catch (error) {
        console.error('Erro ao solicitar depósito:', error);
        res.status(500).json({ message: 'Erro no servidor ao solicitar depósito.' });
    }
};

/**
 * @desc Solicitar um levantamento (saque)
 * @route POST /api/transactions/withdrawal
 * @access Private
 */
const requestWithdrawal = async (req, res) => {
    const { amount, method, phoneNumber } = req.body;

    if (!amount || !method || !phoneNumber) {
        return res.status(400).json({ message: 'Por favor, forneça o valor, método (M-Pesa/e-Mola) e número de telefone.' });
    }
    if (amount <= 0) {
        return res.status(400).json({ message: 'O valor do levantamento deve ser positivo.' });
    }
    if (!['M-Pesa', 'e-Mola'].includes(method)) {
        return res.status(400).json({ message: 'Método de levantamento inválido. Use "M-Pesa" ou "e-Mola".' });
    }

    try {
        const user = await User.findById(req.user._id);

        const platformSettings = await PlatformSettings.findOne();
        const minWithdrawal = platformSettings ? platformSettings.minWithdrawal : 100;
        const maxWithdrawal = platformSettings ? platformSettings.maxWithdrawal : user.balance;

        if (amount < minWithdrawal) {
             return res.status(400).json({ message: `O valor mínimo para levantamento é ${minWithdrawal} MT.` });
        }
        if (amount > user.balance) {
            return res.status(400).json({ message: 'Saldo insuficiente para realizar este levantamento.' });
        }
        if (amount > maxWithdrawal) {
            return res.status(400).json({ message: `O valor máximo para levantamento é ${maxWithdrawal} MT.` });
        }

        const withdrawal = await Withdrawal.create({
            userId: req.user._id,
            amount,
            method,
            phoneNumber,
            status: 'pending'
        });

        user.balance -= amount;
        await user.save();

        res.status(201).json({
            message: 'Solicitação de levantamento enviada com sucesso! Aguardando aprovação.',
            withdrawalId: withdrawal._id,
            status: withdrawal.status
        });

    } catch (error) {
        console.error('Erro ao solicitar levantamento:', error);
        res.status(500).json({ message: 'Erro no servidor ao solicitar levantamento.' });
    }
};

/**
 * @desc Obter histórico de partidas jogadas pelo usuário
 * @route GET /api/games/history
 * @access Private
 */
const getGameHistory = async (req, res) => {
    try {
        const games = await Game.find({
            'players.userId': req.user._id,
            status: { $in: ['completed', 'cancelled'] }
        })
        .populate('players.userId', 'username avatar')
        .populate('winner', 'username')
        .sort({ createdAt: -1 });

        const formattedGames = games.map(game => {
            const player1 = game.players.find(p => p.userId._id.equals(req.user._id));
            const player2 = game.players.find(p => !p.userId._id.equals(req.user._id));
            const didWin = game.winner && game.winner._id.equals(req.user._id);

            return {
                gameId: game._id,
                betAmount: game.betAmount,
                opponent: player2 ? { username: player2.username, avatar: player2.userId.avatar } : 'N/A',
                result: game.status === 'completed' ? (didWin ? 'Vitória' : 'Derrota') : 'Cancelada',
                winner: game.winner ? game.winner.username : 'N/A',
                startTime: game.startTime,
                endTime: game.endTime,
            };
        });

        res.status(200).json(formattedGames);

    } catch (error) {
        console.error('Erro ao obter histórico de partidas:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter histórico de partidas.' });
    }
};

// --- Controladores de Lobby ---

/**
 * @desc Criar uma nova sala de lobby para apostas
 * @route POST /api/lobby/create
 * @access Private
 */
const createLobby = async (req, res) => {
    const { betAmount, shortDescription } = req.body;

    if (!betAmount) {
        return res.status(400).json({ message: 'Por favor, forneça o valor da aposta.' });
    }
    if (betAmount <= 0) {
        return res.status(400).json({ message: 'O valor da aposta deve ser positivo.' });
    }

    try {
        const user = await User.findById(req.user._id);
        if (user.balance < betAmount) {
            return res.status(400).json({ message: 'Saldo insuficiente para criar esta aposta.' });
        }

        const platformSettings = await PlatformSettings.findOne();
        const maxBet = platformSettings ? platformSettings.maxBet : 1000;

        if (betAmount > maxBet) {
            return res.status(400).json({ message: `O valor máximo de aposta é ${maxBet} MT.` });
        }

        const existingOpenLobby = await LobbyRoom.findOne({ 'creator.userId': user._id, status: 'open' });
        if (existingOpenLobby) {
            return res.status(400).json({ message: 'Você já tem um lobby de aposta aberto. Por favor, espere ou cancele-o.' });
        }

        user.balance -= betAmount;
        await user.save();

        const lobby = await LobbyRoom.create({
            creator: {
                userId: user._id,
                username: user.username,
            },
            betAmount,
            shortDescription: shortDescription || `Apostando ${betAmount} MT! Venha jogar!`,
            status: 'open',
        });

        io.emit('newGgLobby', lobby);

        res.status(201).json({
            message: 'Lobby de aposta criado com sucesso! Aguardando um adversário.',
            lobby
        });

    } catch (error) {
        console.error('Erro ao criar lobby:', error);
        res.status(500).json({ message: 'Erro no servidor ao criar lobby.' });
    }
};

/**
 * @desc Entrar em uma sala de lobby e iniciar a partida
 * @route POST /api/lobby/:lobbyId/join
 * @access Private
 */
const joinLobby = async (req, res) => {
    const { lobbyId } = req.params;

    try {
        const user = await User.findById(req.user._id);

        const lobby = await LobbyRoom.findById(lobbyId);

        if (!lobby) {
            return res.status(404).json({ message: 'Lobby não encontrado.' });
        }
        if (lobby.status !== 'open') {
            return res.status(400).json({ message: 'Este lobby não está aberto para novas entradas.' });
        }
        if (lobby.creator.userId.equals(user._id)) {
            return res.status(400).json({ message: 'Você não pode entrar no seu próprio lobby.' });
        }
        if (user.balance < lobby.betAmount) {
            return res.status(400).json({ message: 'Saldo insuficiente para entrar nesta aposta.' });
        }
        const existingOpenLobby = await LobbyRoom.findOne({ 'creator.userId': user._id, status: 'open' });
        if (existingOpenLobby) {
            return res.status(400).json({ message: 'Você já tem um lobby de aposta aberto. Cancele-o para entrar em outro.' });
        }

        user.balance -= lobby.betAmount;
        await user.save();

        lobby.opponent = { userId: user._id, username: user.username };
        lobby.status = 'in-game';
        await lobby.save();

        const players = [];
        const creatorUser = await User.findById(lobby.creator.userId);
        let whitePlayer, blackPlayer;

        if (Math.random() < 0.5) {
            whitePlayer = { userId: creatorUser._id, username: creatorUser.username, color: 'white' };
            blackPlayer = { userId: user._id, username: user.username, color: 'black' };
        } else {
            whitePlayer = { userId: user._id, username: user.username, color: 'white' };
            blackPlayer = { userId: creatorUser._id, username: creatorUser.username, color: 'black' };
        }
        players.push(whitePlayer, blackPlayer);

        const newGame = await Game.create({
            players,
            boardState: JSON.stringify(initialBoardState),
            currentPlayer: 'white',
            status: 'in-progress',
            betAmount: lobby.betAmount,
            lobbyId: lobby._id
        });

        lobby.gameId = newGame._id;
        await lobby.save();

        io.emit('lobbyUpdated', { lobbyId: lobby._id, status: 'in-game' });
        io.to(newGame._id.toString()).emit('gameStarted', {
            gameId: newGame._id,
            players: await Promise.all(newGame.players.map(async p => { // Fetch avatars here
                const pUser = await User.findById(p.userId);
                return { username: p.username, color: p.color, userId: p.userId, avatar: pUser ? pUser.avatar : null };
            })),
            initialBoard: initialBoardState,
            currentPlayer: newGame.currentPlayer,
            betAmount: newGame.betAmount,
            message: 'Partida iniciada! Você foi redirecionado para a tela de jogo.'
        });

        res.status(200).json({
            message: 'Você entrou no lobby e a partida começou!',
            gameId: newGame._id,
            lobbyId: lobby._id,
            players: newGame.players.map(p => ({ username: p.username, color: p.color }))
        });

    } catch (error) {
        console.error('Erro ao entrar no lobby:', error);
        res.status(500).json({ message: 'Erro no servidor ao entrar no lobby.' });
    }
};

/**
 * @desc Cancelar um lobby criado pelo usuário
 * @route DELETE /api/lobby/:lobbyId
 * @access Private
 */
const cancelLobby = async (req, res) => {
    const { lobbyId } = req.params;

    try {
        const lobby = await LobbyRoom.findById(lobbyId);

        if (!lobby) {
            return res.status(404).json({ message: 'Lobby não encontrado.' });
        }

        if (!lobby.creator.userId.equals(req.user._id)) {
            return res.status(403).json({ message: 'Você não tem permissão para cancelar este lobby.' });
        }

        if (lobby.status !== 'open') {
            return res.status(400).json({ message: 'Não é possível cancelar um lobby que não está mais aberto.' });
        }

        const user = await User.findById(req.user._id);
        user.balance += lobby.betAmount;
        await user.save();

        lobby.status = 'closed';
        await lobby.save();

        io.emit('lobbyCancelled', { lobbyId: lobby._id, message: 'Lobby cancelado.' });

        res.status(200).json({ message: 'Lobby cancelado e valor da aposta estornado.', lobbyId: lobby._id });

    } catch (error) {
        console.error('Erro ao cancelar lobby:', error);
        res.status(500).json({ message: 'Erro no servidor ao cancelar lobby.' });
    }
};


/**
 * @desc Obter lista de lobbies abertos
 * @route GET /api/lobby
 * @access Public
 */
const getLobbies = async (req, res) => {
    try {
        const lobbies = await LobbyRoom.find({ status: 'open' })
            .select('creator.username betAmount shortDescription createdAt creator.userId') // Inclui creator.userId
            .sort({ createdAt: -1 });

        // Adicionar avatar do criador, se disponível, para exibir no frontend
        const lobbiesWithAvatars = await Promise.all(lobbies.map(async (lobby) => {
            const creatorUser = await User.findById(lobby.creator.userId).select('avatar');
            return {
                ...lobby.toObject(), // Converte para objeto JS puro
                creator: {
                    username: lobby.creator.username,
                    userId: lobby.creator.userId,
                    avatar: creatorUser ? creatorUser.avatar : 'https://res.cloudinary.com/dje6f5k5u/image/upload/v1/default_avatar.png'
                }
            };
        }));

        res.status(200).json(lobbiesWithAvatars);

    } catch (error) {
        console.error('Erro ao obter lobbies:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter lobbies.' });
    }
};
// ... rest of controllers.js (admin functions and exports) ...

// --- EXPORTAÇÕES ---
module.exports = {
    // Middlewares e Socket.io
    protect,
    authorize,
    initializeSocketIO,

    // Autenticação e Usuário
    registerUser,
    loginUser,
    forgotPassword,
    resetPassword,
    getUserProfile,
    updateUserProfile,
    uploadAvatar,
    getRanking,

    // Transações
    requestDeposit,
    requestWithdrawal,
    getGameHistory,

    // Lobby
    createLobby,
    joinLobby,
    cancelLobby,
    getLobbies,

    // Admin
    adminLogin,
    getAllUsers,
    blockUser,
    unblockUser,
    getPendingDeposits,
    approveDeposit,
    rejectDeposit,
    getPendingWithdrawals,
    approveWithdrawal,
    rejectWithdrawal,
    addBalance,
    removeBalance,
    getLiveGames,
    getCompletedGames,
    getPlatformFinancialSummary,
    updatePlatformSettings,
    getPlatformSettings,
};