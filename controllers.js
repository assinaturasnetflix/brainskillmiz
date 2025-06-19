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
const CLOUDINARY_NAME = process.env.CLOUDINARY_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS; // Senha de aplicativo do Google/Outlook

// Validação de variáveis de ambiente
if (!JWT_SECRET || !CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET || !EMAIL_USER || !EMAIL_PASS) {
    console.error("ERRO: Variáveis de ambiente essenciais não definidas. Verifique seu arquivo .env.");
    process.exit(1); // Encerra o aplicativo se as configurações essenciais estiverem faltando
}

// Configuração do Cloudinary
cloudinary.config({
    cloud_name: CLOUD_NAME,
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
            // Obter token do cabeçalho
            token = req.headers.authorization.split(' ')[1];

            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            // Anexar o usuário do token à requisição
            req.user = await User.findById(decoded.id).select('-password'); // Não retornar a senha

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

        socket.on('disconnect', () => {
            console.log(`Cliente desconectado: ${socket.id}`);
            // TODO: Lidar com desconexão de jogadores em partidas ativas
            // Se um jogador desconectar durante uma partida, o outro vence por WO.
            // Isso requer lógica para identificar qual sala de jogo o socket estava.
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

                // Verifica se o usuário é um dos jogadores da partida
                const isPlayer = game.players.some(p => p.userId.equals(user._id));
                if (!isPlayer) {
                    socket.emit('gameError', { message: 'Você não é um jogador nesta partida.' });
                    return;
                }

                socket.join(gameId);
                console.log(`Usuário ${user.username} (${user._id}) entrou na sala de jogo ${gameId}`);
                socket.emit('joinedGameRoom', { gameId, message: 'Você entrou na sala da partida.' });

                // Opcional: Enviar o estado atual do jogo para o novo participante
                io.to(gameId).emit('gameStateUpdate', {
                    gameId: game._id,
                    boardState: JSON.parse(game.boardState),
                    currentPlayer: game.currentPlayer,
                    status: game.status,
                    players: game.players.map(p => ({ username: p.username, color: p.color }))
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

                // Verifica se é a vez do jogador
                const currentPlayerColor = game.currentPlayer;
                if (playerInGame.color !== currentPlayerColor) {
                    socket.emit('moveError', { message: 'Não é sua vez de jogar.' });
                    return;
                }

                let currentBoard = JSON.parse(game.boardState);
                const fromCoord = move.from;
                const toCoord = move.to;

                // --- VALIDAÇÃO DA JOGADA NO BACKEND (REGRAS DA DAMA BRASILEIRA) ---
                // Esta é a parte mais complexa e crucial.
                // A função `validateAndApplyMove` será definida mais abaixo.
                const validationResult = validateAndApplyMove(currentBoard, fromCoord, toCoord, currentPlayerColor);

                if (!validationResult.isValid) {
                    socket.emit('moveError', { message: validationResult.message });
                    return;
                }

                // Se a jogada é válida, atualiza o estado do tabuleiro
                game.boardState = JSON.stringify(validationResult.newBoard);
                game.moves.push({ player: user._id, from: fromCoord, to: toCoord, capturedPieces: validationResult.capturedPieces });

                // Verifica fim de jogo e troca o turno
                let gameEnded = false;
                let winnerUser = null;
                let loserUser = null;

                // TODO: Implementar lógica de fim de jogo mais robusta
                // 1. Checar se o oponente não tem mais peças
                // 2. Checar se o oponente não tem mais movimentos válidos
                // 3. Empate por repetição de movimentos ou 20 movimentos sem captura/promoção (regra oficial, opcional)

                const opponentColor = currentPlayerColor === 'white' ? 'black' : 'white';
                const opponentPlayer = game.players.find(p => p.color === opponentColor);

                if (validationResult.capturedPieces.length > 0) {
                    // Se houve captura, o turno pode não trocar imediatamente se houver mais capturas obrigatórias
                    // TODO: Implementar lógica de captura múltipla (multiple jump) aqui.
                    // Para simplificar, por enquanto, a cada captura, o turno troca.
                    // Em uma implementação completa, você verificaria se o mesmo jogador pode capturar novamente.
                }

                const remainingPiecesOpponent = countPieces(validationResult.newBoard, opponentColor);
                if (remainingPiecesOpponent === 0) {
                    gameEnded = true;
                    winnerUser = user;
                    loserUser = await User.findById(opponentPlayer.userId);
                    game.status = 'completed';
                    game.winner = winnerUser._id;
                    game.loser = loserUser._id;
                    game.endTime = new Date();
                } else {
                    // Troca o turno apenas se não houver mais capturas obrigatórias para o jogador atual
                    // (Lógica mais avançada de damas)
                    game.currentPlayer = opponentColor;
                }


                await game.save();

                // Notificar todos na sala sobre a atualização do tabuleiro
                io.to(gameId).emit('gameStateUpdate', {
                    gameId: game._id,
                    boardState: JSON.parse(game.boardState),
                    currentPlayer: game.currentPlayer,
                    status: game.status,
                    players: game.players.map(p => ({ username: p.username, color: p.color }))
                });

                if (gameEnded && winnerUser && loserUser) {
                    // Paga o vencedor e processa a comissão
                    const platformSettings = await PlatformSettings.findOne();
                    const commissionRate = platformSettings ? platformSettings.commissionRate : 0.10; // Padrão 10%

                    const winnerAmount = game.betAmount * (1 + (1 - commissionRate)); // Ganhos líquidos = Aposta + (Aposta - 10% de comissão)
                    const loserAmount = -game.betAmount; // Perda total da aposta
                    const platformCommission = game.betAmount * commissionRate; // Comissão da plataforma

                    winnerUser.balance += winnerAmount;
                    winnerUser.totalWins += 1;
                    winnerUser.totalGames += 1;
                    // A comissão da plataforma é sobre o ganho bruto do jogador
                    // No caso da damas, o "ganho" do usuário é o valor da aposta do adversário.
                    // A comissão é 10% *do valor * que o jogador **ganhou** (o valor da aposta do adversário).
                    // Portanto, o jogador recebe (100% - 10%) do valor que o adversário apostou.
                    // O valor ganho pelo usuário em si é o `game.betAmount` do adversário.
                    winnerUser.platformCommissionEarned += platformCommission; // A comissão do usuário é o que a plataforma RETÉM do GANHO dele.

                    loserUser.balance -= game.betAmount; // O perdedor perde o valor apostado
                    loserUser.totalLosses += 1;
                    loserUser.totalGames += 1;

                    await winnerUser.save();
                    await loserUser.save();

                    // Notificar os jogadores sobre o resultado final
                    io.to(gameId).emit('gameOver', {
                        winner: { userId: winnerUser._id, username: winnerUser.username },
                        loser: { userId: loserUser._id, username: loserUser.username },
                        betAmount: game.betAmount,
                        winnerNetGain: winnerAmount,
                        platformCommission: platformCommission,
                        message: `${winnerUser.username} venceu a partida e ganhou ${winnerAmount} MT!`
                    });

                    // Limpar lobby se existir
                    if (game.lobbyId) {
                        await LobbyRoom.findByIdAndUpdate(game.lobbyId, { status: 'closed' });
                    }
                }

            } catch (error) {
                console.error('Erro ao fazer jogada:', error);
                socket.emit('moveError', { message: 'Erro interno ao processar a jogada.', error: error.message });
            }
        });

        // TODO: Adicionar mais eventos de Socket.io conforme necessário
        // Ex: chat na sala de jogo, desistência, propostas de empate.
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

    // Copia o tabuleiro para não modificar o original diretamente durante a validação
    let newBoard = JSON.parse(JSON.stringify(board));
    let capturedPieces = [];

    const isKing = (piece === 'W' || piece === 'B');
    const rowDiff = toRow - fromRow;
    const colDiff = toCol - fromCol;

    // A peça deve se mover na diagonal
    if (Math.abs(rowDiff) !== Math.abs(colDiff) || Math.abs(rowDiff) === 0) {
        return { isValid: false, message: 'Movimento inválido: peças de dama movem-se apenas na diagonal.' };
    }

    // --- Lógica de Captura Obrigatória ---
    // Primeiro, verifica se há *qualquer* captura disponível para o jogador atual.
    const allPossibleCaptures = findAllPossibleCaptures(newBoard, currentPlayerColor);
    const isCaptureAvailable = allPossibleCaptures.length > 0;
    let isCurrentMoveACapture = false;

    // Distância de 1 casa (movimento normal ou captura de peão)
    if (Math.abs(rowDiff) === 1) {
        // Movimento normal de peão (não captura)
        if (getPiece(newBoard, toRow, toCol) !== ' ') {
             return { isValid: false, message: 'Destino ocupado.' };
        }
        if (isCaptureAvailable) {
            return { isValid: false, message: 'Captura obrigatória não realizada.' };
        }
        if (!isKing) { // Peão
            // Peões só andam para frente
            if (currentPlayerColor === 'white' && rowDiff > 0) { // Branco desce no tabuleiro (aumenta linha)
                return { isValid: false, message: 'Peões brancos só podem mover para frente.' };
            }
            if (currentPlayerColor === 'black' && rowDiff < 0) { // Preto sobe no tabuleiro (diminui linha)
                return { isValid: false, message: 'Peões pretos só podem mover para frente.' };
            }
        }
        // Aplica o movimento normal
        newBoard[toRow][toCol] = piece;
        newBoard[fromRow][fromCol] = ' ';

    } else if (Math.abs(rowDiff) === 2 && !isKing) { // Captura de peão (distância de 2)
        const capturedRow = fromRow + (rowDiff / 2);
        const capturedCol = fromCol + (colDiff / 2);
        const capturedPiece = getPiece(newBoard, capturedRow, capturedCol);

        if (getPiece(newBoard, toRow, toCol) !== ' ') {
            return { isValid: false, message: 'Destino da captura ocupado.' };
        }

        const isOpponentPiece = (currentPlayerColor === 'white' && (capturedPiece === 'b' || capturedPiece === 'B')) ||
                               (currentPlayerColor === 'black' && (capturedPiece === 'w' || capturedPiece === 'W'));

        if (!isOpponentPiece) {
            return { isValid: false, message: 'Não há peça inimiga para capturar.' };
        }
        if (!isKing) { // Peão só captura para frente ou para trás
             // Peões só podem capturar para frente (em relação à sua direção de movimento)
             // ou para trás se for uma captura múltipla (não abordado aqui para simplificar)
            // No damas brasileiro, a captura é permitida para frente e para trás para peões.
        }

        // Se houver múltiplas capturas, o jogador deve escolher a que captura o maior número de peças.
        // TODO: Implementar lógica de "maior número de peças" para captura obrigatória.
        // Por enquanto, aceitamos qualquer captura válida se houver captura obrigatória.
        const currentMoveCaptures = findCapturesForMove(newBoard, fromRow, fromCol, toRow, toCol, currentPlayerColor);
        if (currentMoveCaptures.length === 0) {
            return { isValid: false, message: 'Não é uma captura válida.' };
        }

        isCurrentMoveACapture = true;
        capturedPieces.push(rowColToCoord(capturedRow, capturedCol)); // Adiciona a peça capturada
        newBoard[toRow][toCol] = piece;
        newBoard[fromRow][fromCol] = ' ';
        newBoard[capturedRow][capturedCol] = ' '; // Remove a peça capturada

    } else if (isKing && Math.abs(rowDiff) > 1) { // Movimento ou captura de Dama
        // Dama pode mover-se e capturar a qualquer distância na diagonal
        const path = getPath(fromRow, fromCol, toRow, toCol); // Obtém todas as casas no caminho
        let piecesInPath = 0;
        let capturedPieceCoord = null;
        let capturedPieceRow = -1;
        let capturedPieceCol = -1;

        for (let i = 0; i < path.length; i++) {
            const [r, c] = path[i];
            const p = getPiece(newBoard, r, c);
            if (p !== ' ') {
                piecesInPath++;
                const isOpponentPiece = (currentPlayerColor === 'white' && (p === 'b' || p === 'B')) ||
                                       (currentPlayerColor === 'black' && (p === 'w' || p === 'W'));
                if (isOpponentPiece) {
                    capturedPieceCoord = rowColToCoord(r, c);
                    capturedPieceRow = r;
                    capturedPieceCol = c;
                } else {
                    // Peça do próprio jogador no caminho ou mais de uma peça
                    return { isValid: false, message: 'Caminho bloqueado por suas próprias peças ou múltiplas peças no caminho.' };
                }
            }
        }

        if (piecesInPath > 1) {
            return { isValid: false, message: 'Dama não pode saltar sobre mais de uma peça.' };
        }
        if (piecesInPath === 1 && capturedPieceCoord) { // Captura da Dama
            isCurrentMoveACapture = true;
            capturedPieces.push(capturedPieceCoord);
            newBoard[toRow][toCol] = piece;
            newBoard[fromRow][fromCol] = ' ';
            newBoard[capturedPieceRow][capturedPieceCol] = ' '; // Remove a peça capturada
        } else if (piecesInPath === 0) { // Movimento normal da Dama
            if (isCaptureAvailable) {
                return { isValid: false, message: 'Captura obrigatória não realizada.' };
            }
            newBoard[toRow][toCol] = piece;
            newBoard[fromRow][fromCol] = ' ';
        } else {
            return { isValid: false, message: 'Movimento de Dama inválido.' };
        }
    } else {
        return { isValid: false, message: 'Movimento inválido ou desconhecido para a peça.' };
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
// controllers.js (Continuação - Parte 2)

// ... (Conteúdo da Parte 1, incluindo imports, configs, protect, authorize, initializeSocketIO e funções auxiliares de jogo)

// --- Controladores de Autenticação e Usuário ---

/**
 * @desc Registrar um novo usuário
 * @route POST /api/auth/register
 * @access Public
 */
const registerUser = async (req, res) => {
    const { username, email, password, mPesaNumber, eMolaNumber } = req.body;

    // Validação básica
    if (!username || !email || !password) {
        return res.status(400).json({ message: 'Por favor, insira todos os campos obrigatórios: username, email e password.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ message: 'A senha deve ter pelo menos 6 caracteres.' });
    }

    try {
        // Verificar se o usuário já existe
        let user = await User.findOne({ $or: [{ email }, { username }] });
        if (user) {
            return res.status(400).json({ message: 'Usuário ou e-mail já registrado.' });
        }

        // Criar novo usuário
        user = await User.create({
            username,
            email,
            password, // A senha será hashada pelo hook pre-save no modelo User
            mPesaNumber: mPesaNumber || undefined,
            eMolaNumber: eMolaNumber || undefined,
        });

        // Gerar token JWT
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

        // Verificar se a conta está bloqueada
        if (user.isBlocked) {
            return res.status(403).json({ message: 'Sua conta está bloqueada. Entre em contato com o suporte.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Credenciais inválidas.' });
        }

        // Gerar token JWT
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
            // Para segurança, não informar se o e-mail não existe
            return res.status(200).json({ message: 'Se o e-mail estiver registrado, um código de recuperação será enviado.' });
        }

        const resetCode = uuidv4().substring(0, 6).toUpperCase(); // Gera um código de 6 caracteres
        const resetExpires = Date.now() + 10 * 60 * 1000; // Código expira em 10 minutos

        user.passwordResetCode = resetCode;
        user.passwordResetExpires = resetExpires;
        await user.save();

        const platformSettings = await PlatformSettings.findOne();
        const platformName = platformSettings ? platformSettings.platformName : "BrainSkill";

        // Conteúdo HTML do e-mail estilizado
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
            passwordResetExpires: { $gt: Date.now() } // Código não expirou
        });

        if (!user) {
            return res.status(400).json({ message: 'Código de recuperação inválido ou expirado.' });
        }

        // Hash da nova senha
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.passwordResetCode = undefined; // Limpa o código
        user.passwordResetExpires = undefined; // Limpa a expiração
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
        // O usuário já está disponível em req.user graças ao middleware 'protect'
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

        // Atualizar campos permitidos
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
        if (mPesaNumber !== undefined) { // Permite limpar o número
            user.mPesaNumber = mPesaNumber;
        }
        if (eMolaNumber !== undefined) { // Permite limpar o número
            user.eMolaNumber = eMolaNumber;
        }
        if (newPassword) {
            if (newPassword.length < 6) {
                return res.status(400).json({ message: 'A nova senha deve ter pelo menos 6 caracteres.' });
            }
            // A senha será hashada pelo hook pre-save no modelo User ao salvar
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
        // Capturar erro de validação de duplicidade que pode ocorrer mesmo com a verificação manual
        if (error.code === 11000) { // Erro de duplicidade do MongoDB
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
        // req.file virá do middleware de upload (que não podemos adicionar aqui diretamente devido à restrição de arquivos)
        // Para simular, esperamos que o frontend envie o URL da imagem já para o Cloudinary,
        // ou que o 'body' contenha 'imageData' (base64) ou 'imageUrl'.
        // **Para este projeto, devido à restrição de não usar pacotes extras para upload de arquivos (ex: multer),
        // o frontend deverá enviar a imagem já processada e hospedada no Cloudinary,
        // ou o backend precisaria de uma lógica de upload mais complexa sem multer, o que foge do escopo de 4 arquivos.**
        //
        // Assumindo que 'req.body.imageUrl' ou 'req.body.imageData' virá:

        let imageUrl = req.body.imageUrl; // Se o frontend já subiu e enviou a URL
        const imageData = req.body.imageData; // Se o frontend enviou base64 e o backend vai subir

        if (!imageUrl && !imageData) {
            return res.status(400).json({ message: 'Nenhuma imagem fornecida para upload.' });
        }

        if (imageData) {
            // Upload para Cloudinary usando base64
            const result = await cloudinary.uploader.upload(imageData, {
                folder: 'brainskill_avatars', // Pasta no Cloudinary
                width: 150,
                height: 150,
                crop: 'fill'
            });
            imageUrl = result.secure_url;
        } else if (imageUrl && !imageUrl.startsWith('http')) { // Pequena validação para garantir que é uma URL
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
        // Ordenar por totalWins, depois por totalGames, e balance como desempate
        const ranking = await User.find({ role: 'user', isBlocked: false })
            .select('username avatar totalWins totalLosses totalGames balance') // Seleciona apenas campos públicos
            .sort({ totalWins: -1, totalGames: -1, balance: -1 })
            .limit(50); // Limite para um ranking razoável

        res.status(200).json(ranking);

    } catch (error) {
        console.error('Erro ao obter ranking:', error);
        res.status(500).json({ message: 'Erro no servidor ao obter ranking.' });
    }
};

// Instruções para a próxima parte:
// A seguir, adicionaremos os controladores para as rotas de transações (depósitos e levantamentos).
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
    } catch (error) {
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

    } catch (error) {
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

    } catch (error) {
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
    } catch (error) {
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
    } catch (error) {
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
    } catch (error) {
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
    } catch (error) {
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

    } catch (error) {
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
    } catch (error) {
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
    } catch (error) {
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
}; // This is the closing brace for module.exports
// There should be NOTHING after this closing brace and semicolon, except possibly blank lines.