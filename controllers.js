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
const CLOUDINARY_CLOUD_NAME_ENV = process.env.CLOUDINARY_CLOUD_NAME; // AGORA LÊ CLOUDINARY_CLOUD_NAME do .env
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

// Validação de variáveis de ambiente
if (!JWT_SECRET || !CLOUDINARY_CLOUD_NAME_ENV || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET || !EMAIL_USER || !EMAIL_PASS) {
    console.error("ERRO: Variáveis de ambiente essenciais não definidas. Verifique seu arquivo .env.");
    process.exit(1);
}

// Configuração do Cloudinary
cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME_ENV,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
});

// Configuração do Nodemailer
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false
    }
});

// --- Middlewares de Autenticação e Autorização ---

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

let io;

const initializeSocketIO = (socketInstance) => {
    io = socketInstance;
    console.log('Socket.io inicializado e pronto para uso.');

    io.on('connection', (socket) => {
        console.log(`Novo cliente conectado: ${socket.id}`);

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
                socket.join(userId);
                console.log(`Usuário <span class="math-inline">\{user\.username\} \(</span>{user._id}) entrou na sala pessoal.`);
            } catch (error) {
                console.error('Erro ao juntar-se à sala do usuário:', error);
                socket.emit('authError', { message: 'Falha na autenticação do usuário para sala pessoal.' });
            }
        });


        socket.on('disconnect', () => {
            console.log(`Cliente desconectado: ${socket.id}`);
            // TODO: Lidar com desconexão de jogadores em partidas ativas
            // Se um jogador desconectar durante uma partida, o outro vence por WO.
            // Isso requer lógica para identificar qual sala de jogo o socket estava.
        });

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

                const rooms = io.sockets.adapter.sids.get(socket.id);
                if (rooms && rooms.has(gameId.toString())) {
                    console.log(`Usuário ${user.username} já está na sala de jogo ${gameId}`);
                    socket.emit('joinedGameRoom', { gameId, message: 'Você já está na sala da partida.' });
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


                socket.join(gameId.toString());
                console.log(`Usuário <span class="math-inline">\{user\.username\} \(</span>{user._id}) entrou na sala de jogo ${gameId}`);
                socket.emit('joinedGameRoom', { gameId, message: 'Você entrou na sala da partida.' });

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
                    game.currentPlayer = opponentColor;
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

                    const winnerGrossGain = game.betAmount;
                    const platformCommission = winnerGrossGain * commissionRate;
                    const winnerNetGain = winnerGrossGain - platformCommission;

                    winnerUser.balance += winnerGrossGain;
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
                        winnerNetGain: winnerNetGain,
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
                
                game.status = 'completed';
                game.winner = winnerUser._id;
                game.loser = user._id;
                game.endTime = new Date();
                await game.save();

                const platformSettings = await PlatformSettings.findOne();
                const commissionRate = platformSettings ? platformSettings.commissionRate : 0.10;

                const winnerGrossGain = game.betAmount;
                const platformCommission = winnerGrossGain * commissionRate;
                const winnerNetGain = winnerGrossGain - platformCommission;

                winnerUser.balance += winnerGrossGain;
                winnerUser.totalWins += 1;
                winnerUser.totalGames += 1;
                winnerUser.platformCommissionEarned += platformCommission;

                user.balance -= game.betAmount;
                user.totalLosses += 1;
                user.totalGames += 1;

                await winnerUser.save();
                await user.save();

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
    return `<span class="math-inline">\{char\}</span>{num}`;
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

    // Validação final: Se houver captura obrigatória e o movimento atual não for uma captura, é inválido.
    if (isCaptureAvailable && !isCurrentMoveACapture) {
        return { isValid: false, message: 'Captura obrigatória não realizada. Você deve capturar uma peça.' };
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

    while (r !== r2 && c !== c2) {
        path.push([r, c]);
        r += dr;
        c += dc;
    }
    return path;
};

// Auxiliar para encontrar todas as possíveis capturas para um jogador.
const findAllPossibleCaptures = (board, playerColor) => {
    const captures = [];
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = getPiece(board, r, c);
            const isCurrentPlayerPiece = (playerColor === 'white' && (piece === 'w' || piece === 'W')) ||
                                         (playerColor === 'black' && (piece === 'b' || piece === 'B'));

            if (isCurrentPlayerPiece) {
                // Verificar 4 direções diagonais para capturas
                const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]]; // DR, DC
                for (const [dr, dc] of directions) {
                    const opponentRow = r + dr;
                    const opponentCol = c + dc;
                    const landingRow = r + 2 * dr;
                    const landingCol = c + 2 * dc;

                    if (isValidPosition(landingRow, landingCol) && getPiece(board, landingRow, landingCol) === ' ') {
                        const opponentPiece = getPiece(board, opponentRow, opponentCol);
                        const isOpponentPiece = (playerColor === 'white' && (opponentPiece === 'b' || opponentPiece === 'B')) ||
                                               (playerColor === 'black' && (opponentPiece === 'w' || opponentPiece === 'W'));
                        if (isOpponentPiece) {
                            // Captura possível
                            captures.push({ from: rowColToCoord(r, c), to: rowColToCoord(landingRow, landingCol), captured: rowColToCoord(opponentRow, opponentCol) });
                        }
                    }
                }
                // Para damas, é mais complexo, exigiria verificar todas as distâncias diagonais para captura
                if (piece === 'W' || piece === 'B') {
                    // TODO: Implementar lógica de captura para Dama (pode saltar múltiplas casas)
                    // Isso é um pouco mais complexo, mas segue a mesma lógica:
                    // Verifique se há uma peça inimiga em qualquer casa diagonal e um espaço vazio depois dela.
                    // Para simplificar, o exemplo acima cobre apenas 2 casas.
                    // Uma dama pode capturar a qualquer distância se a casa logo após a peça inimiga estiver vazia.
                }
            }
        }
    }
    return captures;
};

// Auxiliar para verificar se uma jogada específica é uma captura
const findCapturesForMove = (board, fromRow, fromCol, toRow, toCol, currentPlayerColor) => {
    const capturedPieces = [];
    const piece = getPiece(board, fromRow, fromCol);
    const isKing = (piece === 'W' || piece === 'B');

    const rowDiff = toRow - fromRow;
    const colDiff = toCol - fromCol;

    if (Math.abs(rowDiff) === 2 && !isKing) { // Possível captura de peão
        const capturedRow = fromRow + (rowDiff / 2);
        const capturedCol = fromCol + (colDiff / 2);
        const capturedPiece = getPiece(board, capturedRow, capturedCol);

        const isOpponentPiece = (currentPlayerColor === 'white' && (capturedPiece === 'b' || capturedPiece === 'B')) ||
                               (currentPlayerColor === 'black' && (capturedPiece === 'w' || capturedPiece === 'W'));
        if (isOpponentPiece) {
            capturedPieces.push(rowColToCoord(capturedRow, capturedCol));
        }
    } else if (isKing && Math.abs(rowDiff) > 1) { // Possível captura de dama
        const path = getPath(fromRow, fromCol, toRow, toCol);
        let foundOpponent = false;
        let capturedCoord = null;
        for (let i = 0; i < path.length; i++) {
            const [r, c] = path[i];
            const p = getPiece(board, r, c);
            if (p !== ' ') {
                const isOpponentPiece = (currentPlayerColor === 'white' && (p === 'b' || p === 'B')) ||
                                       (currentPlayerColor === 'black' && (p === 'w' || p === 'W'));
                if (isOpponentPiece && !foundOpponent) {
                    foundOpponent = true;
                    capturedCoord = rowColToCoord(r, c);
                } else {
                    // Mais de uma peça no caminho ou uma peça própria
                    return []; // Não é uma captura válida ou caminho bloqueado
                }
            }
        }
        if (foundOpponent && capturedCoord) {
            capturedPieces.push(capturedCoord);
        }
    }
    return capturedPieces;
};

// --- Fim das Funções Auxiliares de Jogo ---

// Instruções para a próxima parte:
// A seguir, adicionaremos os controladores para as rotas de usuário e autenticação.
// controllers.js (Continuação - Parte 3)

// ... (Conteúdo da Parte 1 e Parte 2)

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
            status: 'pending' // Começa como pendente para aprovação do admin
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

        // TODO: Definir limite mínimo e máximo para saque nas configurações da plataforma
        const platformSettings = await PlatformSettings.findOne();
        const minWithdrawal = platformSettings ? platformSettings.minWithdrawal : 100; // Exemplo de limite
        // maxWithdrawal talvez seja o balanço total? Ou um limite fixo.
        const maxWithdrawal = platformSettings ? platformSettings.maxWithdrawal : user.balance; // Pode ser o saldo disponível ou um limite fixo

        if (amount < minWithdrawal) {
             return res.status(400).json({ message: `O valor mínimo para levantamento é ${minWithdrawal} MT.` });
        }
        if (amount > user.balance) {
            return res.status(400).json({ message: 'Saldo insuficiente para realizar este levantamento.' });
        }
        if (amount > maxWithdrawal) {
            return res.status(400).json({ message: `O valor máximo para levantamento é ${maxWithdrawal} MT.` });
        }

        // Cria a solicitação de levantamento (status pendente)
        const withdrawal = await Withdrawal.create({
            userId: req.user._id,
            amount,
            method,
            phoneNumber,
            status: 'pending'
        });

        // Deduz temporariamente o valor do saldo do usuário para evitar gastos duplos
        // Este valor será ajustado (confirmado ou estornado) pelo admin
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
        // Encontra todas as partidas onde o usuário foi um dos jogadores
        const games = await Game.find({
            'players.userId': req.user._id,
            status: { $in: ['completed', 'cancelled'] } // Apenas partidas finalizadas ou canceladas
        })
        .populate('players.userId', 'username avatar') // Popula dados básicos dos jogadores
        .populate('winner', 'username') // Popula o nome do vencedor
        .sort({ createdAt: -1 }); // Mais recentes primeiro

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
        const maxBet = platformSettings ? platformSettings.maxBet : 1000; // Limite padrão de aposta

        if (betAmount > maxBet) {
            return res.status(400).json({ message: `O valor máximo de aposta é ${maxBet} MT.` });
        }

        // Verifica se o usuário já tem um lobby aberto
        const existingOpenLobby = await LobbyRoom.findOne({ 'creator.userId': user._id, status: 'open' });
        if (existingOpenLobby) {
            return res.status(400).json({ message: 'Você já tem um lobby de aposta aberto. Por favor, espere ou cancele-o.' });
        }

        // Deduz o valor da aposta do saldo do criador
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

        // Notificar todos os clientes sobre o novo lobby
        io.emit('newGgLobby', lobby); // 'newGgLobby' é um nome de evento de sua escolha

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
        // Verifica se o usuário já tem um lobby aberto (para não entrar em outro enquanto um já está ativo)
        const existingOpenLobby = await LobbyRoom.findOne({ 'creator.userId': user._id, status: 'open' });
        if (existingOpenLobby) {
            return res.status(400).json({ message: 'Você já tem um lobby de aposta aberto. Cancele-o para entrar em outro.' });
        }

        // Deduz o valor da aposta do saldo do jogador que está entrando
        user.balance -= lobby.betAmount;
        await user.save();

        // Atualiza o lobby com o oponente
        lobby.opponent = { userId: user._id, username: user.username };
        lobby.status = 'in-game';
        await lobby.save();

        // --- Criar nova partida de Damas ---
        // Escolhe aleatoriamente as cores
        const players = [];
        const creatorUser = await User.findById(lobby.creator.userId); // Obter dados completos do criador
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
            boardState: JSON.stringify(initialBoardState), // Estado inicial do tabuleiro
            currentPlayer: 'white', // Branco sempre começa
            status: 'in-progress',
            betAmount: lobby.betAmount,
            lobbyId: lobby._id
        });

        lobby.gameId = newGame._id; // Linka o lobby à nova partida
        await lobby.save();

        // Notificar o criador do lobby e o novo jogador sobre a partida iniciada
        // E também notificar o lobby geral que este lobby foi "fechado" (agora em jogo)
        io.emit('lobbyUpdated', { lobbyId: lobby._id, status: 'in-game' }); // Notifica que o lobby foi pego
        io.to(newGame._id.toString()).emit('gameStarted', {
            gameId: newGame._id,
            players: newGame.players.map(p => ({
                userId: p.userId,
                username: p.username,
                color: p.color,
                avatar: p.userId.equals(creatorUser._id) ? creatorUser.avatar : user.avatar // Para mostrar avatar no frontend
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
        // Em caso de erro, considerar estornar o saldo se já foi deduzido
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

        // Verifica se o usuário logado é o criador do lobby
        if (!lobby.creator.userId.equals(req.user._id)) {
            return res.status(403).json({ message: 'Você não tem permissão para cancelar este lobby.' });
        }

        if (lobby.status !== 'open') {
            return res.status(400).json({ message: 'Não é possível cancelar um lobby que não está mais aberto.' });
        }

        // Estorna o valor da aposta para o criador do lobby
        const user = await User.findById(req.user._id);
        user.balance += lobby.betAmount;
        await user.save();

        // Atualiza o status do lobby para 'cancelled' ou o remove (depende da preferência)
        lobby.status = 'closed'; // Ou 'cancelled' se houver um enum específico
        await lobby.save();
        // Alternativamente: await LobbyRoom.findByIdAndDelete(lobbyId);

        io.emit('lobbyCancelled', { lobbyId: lobby._id, message: 'Lobby cancelado.' }); // Notifica o frontend

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
            .select('creator.username betAmount shortDescription createdAt')
            .sort({ createdAt: -1 });

        res.status(200).json(lobbies);

    } catch (error) {
        console.error('Erro ao obter lobbies:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter lobbies.' });
    }
};

// Instruções para a próxima parte:
// A seguir, adicionaremos os controladores para as rotas administrativas,
// que são as últimas funcionalidades importantes do backend.
// controllers.js (Continuação - Parte 4)

// ... (Conteúdo da Parte 1, Parte 2 e Parte 3)

// --- Controladores Administrativos ---

/**
 * @desc Login do Administrador
 * @route POST /api/admin/login
 * @access Public (mas requer credenciais de admin)
 */
const adminLogin = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Por favor, insira e-mail e senha.' });
    }

    try {
        const user = await User.findOne({ email });

        if (!user || user.role !== 'admin') {
            return res.status(401).json({ message: 'Credenciais de administrador inválidas.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciais de administrador inválidas.' });
        }

        // Gerar token JWT para o admin
        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '8h' }); // Token de admin pode ter validade maior

        res.status(200).json({
            message: 'Login de administrador realizado com sucesso!',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
            },
            token,
        });

    } catch (error) {
        console.error('Erro no login de administrador:', error);
        res.status(500).json({ message: 'Erro no servidor ao fazer login de administrador.' });
    }
};

/**
 * @desc Obter todos os usuários (apenas para admin)
 * @route GET /api/admin/users
 * @access Private/Admin
 */
const getAllUsers = async (req, res) => {
    try {
        // Excluir admins da lista ou incluir conforme necessidade
        const users = await User.find({ role: 'user' }).select('-password'); // Não retornar senhas

        res.status(200).json(users);
    } catch (error) {
        console.error('Erro ao obter todos os usuários:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter usuários.' });
    }
};

/**
 * @desc Bloquear conta de usuário (apenas para admin)
 * @route PUT /api/admin/users/:userId/block
 * @access Private/Admin
 */
const blockUser = async (req, res) => {
    const { userId } = req.params;
    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        if (user.role === 'admin') {
            return res.status(403).json({ message: 'Não é possível bloquear outro administrador.' });
        }

        user.isBlocked = true;
        await user.save();

        res.status(200).json({ message: `Usuário ${user.username} bloqueado com sucesso.` });
    } catch (error) {
        console.error('Erro ao bloquear usuário:', error);
        res.status(500).json({ message: 'Erro no servidor ao bloquear usuário.' });
    }
};

/**
 * @desc Desbloquear conta de usuário (apenas para admin)
 * @route PUT /api/admin/users/:userId/unblock
 * @access Private/Admin
 */
const unblockUser = async (req, res) => {
    const { userId } = req.params;
    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        user.isBlocked = false;
        await user.save();

        res.status(200).json({ message: `Usuário ${user.username} desbloqueado com sucesso.` });
    } catch (error) {
        console.error('Erro ao desbloquear usuário:', error);
        res.status(500).json({ message: 'Erro no servidor ao desbloquear usuário.' });
    }
};

/**
 * @desc Obter solicitações de depósito pendentes (apenas para admin)
 * @route GET /api/admin/deposits/pending
 * @access Private/Admin
 */
const getPendingDeposits = async (req, res) => {
    try {
        const deposits = await Deposit.find({ status: 'pending' }).populate('userId', 'username email');
        res.status(200).json(deposits);
    } catch (error) {
        console.error('Erro ao obter depósitos pendentes:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter depósitos pendentes.' });
    }
};

/**
 * @desc Aprovar uma solicitação de depósito (apenas para admin)
 * @route PUT /api/admin/deposits/:depositId/approve
 * @access Private/Admin
 */
const approveDeposit = async (req, res) => {
    const { depositId } = req.params;
    const { transactionId, adminNotes } = req.body; // Opcional: ID da transação real, notas do admin

    try {
        const deposit = await Deposit.findById(depositId);
        if (!deposit) {
            return res.status(404).json({ message: 'Solicitação de depósito não encontrada.' });
        }
        if (deposit.status !== 'pending') {
            return res.status(400).json({ message: 'Este depósito já foi processado.' });
        }

        const user = await User.findById(deposit.userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário associado ao depósito não encontrado.' });
        }

        // Adicionar o valor ao saldo do usuário
        user.balance += deposit.amount;
        await user.save();

        // Atualizar status do depósito
        deposit.status = 'approved';
        deposit.transactionId = transactionId || deposit.transactionId;
        deposit.adminNotes = adminNotes || deposit.adminNotes;
        deposit.processedBy = req.user._id; // Admin que aprovou
        deposit.processedAt = new Date();
        await deposit.save();

        // Notificar o usuário via Socket.io sobre o depósito aprovado
        io.to(user._id.toString()).emit('balanceUpdate', {
            newBalance: user.balance,
            message: `Seu depósito de ${deposit.amount} MT foi aprovado!`
        });

        res.status(200).json({ message: 'Depósito aprovado com sucesso!', deposit });

    } catch (error) {
        console.error('Erro ao aprovar depósito:', error);
        res.status(500).json({ message: 'Erro no servidor ao aprovar depósito.' });
    }
};

/**
 * @desc Recusar uma solicitação de depósito (apenas para admin)
 * @route PUT /api/admin/deposits/:depositId/reject
 * @access Private/Admin
 */
const rejectDeposit = async (req, res) => {
    const { depositId } = req.params;
    const { adminNotes } = req.body;

    try {
        const deposit = await Deposit.findById(depositId);
        if (!deposit) {
            return res.status(404).json({ message: 'Solicitação de depósito não encontrada.' });
        }
        if (deposit.status !== 'pending') {
            return res.status(400).json({ message: 'Este depósito já foi processado.' });
        }

        // Atualizar status do depósito para rejeitado
        deposit.status = 'rejected';
        deposit.adminNotes = adminNotes || 'Rejeitado pelo administrador.';
        deposit.processedBy = req.user._id;
        deposit.processedAt = new Date();
        await deposit.save();

        // Notificar o usuário via Socket.io sobre o depósito rejeitado
        const user = await User.findById(deposit.userId);
        if (user) {
            io.to(user._id.toString()).emit('balanceUpdate', {
                newBalance: user.balance, // Saldo não mudou
                message: `Seu depósito de ${deposit.amount} MT foi rejeitado. Razão: ${deposit.adminNotes}`
            });
        }


        res.status(200).json({ message: 'Depósito rejeitado com sucesso!', deposit });

    } catch (error) {
        console.error('Erro ao rejeitar depósito:', error);
        res.status(500).json({ message: 'Erro no servidor ao rejeitar depósito.' });
    }
};

/**
 * @desc Obter solicitações de levantamento pendentes (apenas para admin)
 * @route GET /api/admin/withdrawals/pending
 * @access Private/Admin
 */
const getPendingWithdrawals = async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({ status: 'pending' }).populate('userId', 'username email');
        res.status(200).json(withdrawals);
    }
    catch (error) {
        console.error('Erro ao obter levantamentos pendentes:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter levantamentos pendentes.' });
    }
};

/**
 * @desc Aprovar uma solicitação de levantamento (apenas para admin)
 * @route PUT /api/admin/withdrawals/:withdrawalId/approve
 * @access Private/Admin
 */
const approveWithdrawal = async (req, res) => {
    const { withdrawalId } = req.params;
    const { transactionId, adminNotes } = req.body;

    try {
        const withdrawal = await Withdrawal.findById(withdrawalId);
        if (!withdrawal) {
            return res.status(404).json({ message: 'Solicitação de levantamento não encontrada.' });
        }
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ message: 'Este levantamento já foi processado.' });
        }

        // O valor já foi deduzido do usuário no momento da solicitação.
        // Aqui, apenas atualizamos o status e registramos o processamento.

        withdrawal.status = 'approved';
        withdrawal.transactionId = transactionId || withdrawal.transactionId;
        withdrawal.adminNotes = adminNotes || withdrawal.adminNotes;
        withdrawal.processedBy = req.user._id;
        withdrawal.processedAt = new Date();
        await withdrawal.save();

        // Notificar o usuário via Socket.io sobre o levantamento aprovado
        const user = await User.findById(withdrawal.userId);
        if (user) {
            io.to(user._id.toString()).emit('balanceUpdate', {
                newBalance: user.balance, // Saldo já deduzido, apenas para confirmação
                message: `Seu levantamento de ${withdrawal.amount} MT foi aprovado e enviado!`
            });
        }


        res.status(200).json({ message: 'Levantamento aprovado com sucesso!', withdrawal });

    }
    catch (error) {
        console.error('Erro ao aprovar levantamento:', error);
        res.status(500).json({ message: 'Erro no servidor ao aprovar levantamento.' });
    }
};

/**
 * @desc Recusar uma solicitação de levantamento (apenas para admin)
 * @route PUT /api/admin/withdrawals/:withdrawalId/reject
 * @access Private/Admin
 */
const rejectWithdrawal = async (req, res) => {
    const { withdrawalId } = req.params;
    const { adminNotes } = req.body;

    try {
        const withdrawal = await Withdrawal.findById(withdrawalId);
        if (!withdrawal) {
            return res.status(404).json({ message: 'Solicitação de levantamento não encontrada.' });
        }
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ message: 'Este levantamento já foi processado.' });
        }

        const user = await User.findById(withdrawal.userId);
        if (!user) {
            // Este caso não deveria acontecer se o usuário existe, mas é um bom fallback
            return res.status(404).json({ message: 'Usuário associado ao levantamento não encontrado.' });
        }

        // Estornar o valor para o saldo do usuário, pois a solicitação foi rejeitada
        user.balance += withdrawal.amount;
        await user.save();

        // Atualizar status do levantamento para rejeitado
        withdrawal.status = 'rejected';
        withdrawal.adminNotes = adminNotes || 'Rejeitado pelo administrador.';
        withdrawal.processedBy = req.user._id;
        withdrawal.processedAt = new Date();
        await withdrawal.save();

        // Notificar o usuário via Socket.io sobre o levantamento rejeitado
        io.to(user._id.toString()).emit('balanceUpdate', {
            newBalance: user.balance,
            message: `Seu levantamento de ${withdrawal.amount} MT foi rejeitado e o valor estornado para sua conta.`
        });

        res.status(200).json({ message: 'Levantamento rejeitado com sucesso! Valor estornado para o usuário.', withdrawal });

    }
    catch (error) {
        console.error('Erro ao rejeitar levantamento:', error);
        res.status(500).json({ message: 'Erro no servidor ao rejeitar levantamento.' });
    }
};

/**
 * @desc Adicionar saldo manualmente a um usuário (apenas para admin)
 * @route POST /api/admin/users/:userId/add-balance
 * @access Private/Admin
 */
const addBalance = async (req, res) => {
    const { userId } = req.params;
    const { amount, adminNotes } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ message: 'Valor inválido para adicionar saldo.' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        user.balance += amount;
        await user.save();

        // Opcional: registrar esta transação administrativa
        // Poderia ser um novo modelo "AdminTransaction" ou "ManualBalanceAdjustment"

        // Notificar o usuário via Socket.io
        io.to(user._id.toString()).emit('balanceUpdate', {
            newBalance: user.balance,
            message: `${amount} MT adicionado à sua conta pelo administrador. Notas: ${adminNotes || 'N/A'}`
        });

        res.status(200).json({ message: `Saldo de ${amount} MT adicionado ao usuário ${user.username}.`, newBalance: user.balance });
    }
    catch (error) {
        console.error('Erro ao adicionar saldo manualmente:', error);
        res.status(500).json({ message: 'Erro no servidor ao adicionar saldo.' });
    }
};

/**
 * @desc Remover saldo manualmente de um usuário (apenas para admin)
 * @route POST /api/admin/users/:userId/remove-balance
 * @access Private/Admin
 */
const removeBalance = async (req, res) => {
    const { userId } = req.params;
    const { amount, adminNotes } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ message: 'Valor inválido para remover saldo.' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (user.balance < amount) {
            return res.status(400).json({ message: 'Saldo insuficiente para remover este valor.' });
        }

        user.balance -= amount;
        await user.save();

        // Opcional: registrar esta transação administrativa

        // Notificar o usuário via Socket.io
        io.to(user._id.toString()).emit('balanceUpdate', {
            newBalance: user.balance,
            message: `${amount} MT removido da sua conta pelo administrador. Razão: ${adminNotes || 'N/A'}`
        });

        res.status(200).json({ message: `Saldo de ${amount} MT removido do usuário ${user.username}.`, newBalance: user.balance });
    }
    catch (error) {
        console.error('Erro ao remover saldo manualmente:', error);
        res.status(500).json({ message: 'Erro no servidor ao remover saldo.' });
    }
};

/**
 * @desc Obter partidas ao vivo (apenas para admin)
 * @route GET /api/admin/games/live
 * @access Private/Admin
 */
const getLiveGames = async (req, res) => {
    try {
        const liveGames = await Game.find({ status: 'in-progress' })
            .populate('players.userId', 'username avatar')
            .select('-boardState'); // Não retornar o boardState completo para visão geral

        res.status(200).json(liveGames);
    }
    catch (error) {
        console.error('Erro ao obter partidas ao vivo:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter partidas ao vivo.' });
    }
};

/**
 * @desc Obter partidas encerradas (apenas para admin)
 * @route GET /api/admin/games/completed
 * @access Private/Admin
 */
const getCompletedGames = async (req, res) => {
    try {
        const completedGames = await Game.find({ status: 'completed' })
            .populate('players.userId', 'username avatar')
            .populate('winner', 'username')
            .populate('loser', 'username')
            .sort({ endTime: -1 })
            .select('-boardState'); // Não retornar o boardState completo para visão geral

        res.status(200).json(completedGames);
    }
    catch (error) {
        console.error('Erro ao obter partidas encerradas:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter partidas encerradas.' });
    }
};

/**
 * @desc Obter resumo financeiro da plataforma (apenas para admin)
 * @route GET /api/admin/summary
 * @access Private/Admin
 */
const getPlatformFinancialSummary = async (req, res) => {
    try {
        const totalDepositedResult = await Deposit.aggregate([
            { $match: { status: 'approved' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalDeposited = totalDepositedResult.length > 0 ? totalDepositedResult[0].total : 0;

        const totalWithdrawnResult = await Withdrawal.aggregate([
            { $match: { status: 'approved' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalWithdrawn = totalWithdrawnResult.length > 0 ? totalWithdrawnResult[0].total : 0;

        // Total ganho em partidas por usuários (valor total das apostas vencedoras)
        // Isso é o total que os usuários receberam diretamente das apostas dos adversários, antes da comissão.
        // Para calcular a "comissão de plataforma" de 10% do valor ganho,
        // é melhor somar a `platformCommissionEarned` de todos os usuários.
        const totalUserWinsAggregate = await User.aggregate([
            { $group: { _id: null, totalPlatformCommission: { $sum: '$platformCommissionEarned' } } }
        ]);
        const totalPlatformCommission = totalUserWinsAggregate.length > 0 ? totalUserWinsAggregate[0].totalPlatformCommission : 0;

        // Saldo total de todos os usuários
        const totalUserBalanceResult = await User.aggregate([
            { $group: { _id: null, total: { $sum: '$balance' } } }
        ]);
        const totalUserBalance = totalUserBalanceResult.length > 0 ? totalUserBalanceResult[0].total : 0;


        res.status(200).json({
            totalDeposited,
            totalWithdrawn,
            totalPlatformCommission, // Comissão que a plataforma já "ganhou" das partidas
            totalNetBalanceOnPlatform: totalDeposited - totalWithdrawn, // Balanço líquido total (histórico)
            totalUsersCurrentBalance: totalUserBalance // Saldo atual de todos os usuários somados
        });

    }
    catch (error) {
        console.error('Erro ao obter resumo financeiro:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter resumo financeiro.' });
    }
};

/**
 * @desc Obter configurações da plataforma (apenas para admin)
 * @route GET /api/admin/settings
 * @access Private/Admin
 */
const getPlatformSettings = async (req, res) => {
    try {
        let settings = await PlatformSettings.findOne();
        if (!settings) {
            // Se não houver configurações, cria uma com valores padrão
            settings = await PlatformSettings.create({});
        }
        res.status(200).json(settings);
    }
    catch (error) {
        console.error('Erro ao obter configurações da plataforma:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter configurações.' });
    }
};

/**
 * @desc Atualizar configurações da plataforma (apenas para admin)
 * @route PUT /api/admin/settings
 * @access Private/Admin
 */
const updatePlatformSettings = async (req, res) => {
    const { minDeposit, maxDeposit, maxBet, commissionRate, gameRulesText, platformName, contactEmail } = req.body;

    try {
        let settings = await PlatformSettings.findOne();
        if (!settings) {
            settings = await PlatformSettings.create({}); // Cria se não existir
        }

        // Atualiza apenas os campos fornecidos no body
        if (minDeposit !== undefined) settings.minDeposit = minDeposit;
        if (maxDeposit !== undefined) settings.maxDeposit = maxDeposit;
        if (maxBet !== undefined) settings.maxBet = maxBet;
        if (commissionRate !== undefined) settings.commissionRate = commissionRate;
        if (gameRulesText !== undefined) settings.gameRulesText = gameRulesText;
        if (platformName !== undefined) settings.platformName = platformName;
        if (contactEmail !== undefined) settings.contactEmail = contactEmail;
        // Adicionar outros campos de configuração aqui

        await settings.save();

        res.status(200).json({ message: 'Configurações da plataforma atualizadas com sucesso!', settings });
    }
    catch (error) {
        console.error('Erro ao atualizar configurações da plataforma:', error);
        res.status(500).json({ message: 'Erro no servidor ao atualizar configurações.' });
    }
};

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
}

---

