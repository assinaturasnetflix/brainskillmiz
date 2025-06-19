// controllers.js

const { User, Game, Deposit, Withdrawal, LobbyRoom, Setting } = require('./models');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const { promisify } = require('util'); // Para usar jwt.verify com async/await

// Configuração do Cloudinary (substitua com suas credenciais)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração do Nodemailer (substitua com suas credenciais de email)
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Chave Secreta JWT (Mova para variáveis de ambiente em produção)
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforbrainskill';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

// --- Funções Auxiliares de Autenticação ---

const generateToken = (id) => {
    return jwt.sign({ id }, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN
    });
};

// Middleware para proteger rotas (verifica JWT)
exports.protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ message: 'Não autorizado, nenhum token fornecido.' });
    }

    try {
        const decoded = await promisify(jwt.verify)(token, JWT_SECRET);
        req.user = await User.findById(decoded.id).select('-password'); // Anexa o usuário à requisição (sem a senha)
        if (!req.user) {
            return res.status(401).json({ message: 'O token pertence a um usuário que não existe mais.' });
        }
        if (req.user.isBlocked) {
            return res.status(403).json({ message: 'Sua conta está bloqueada.' });
        }
        next();
    } catch (error) {
        console.error('Erro de autenticação:', error);
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expirado. Por favor, faça login novamente.' });
        }
        return res.status(401).json({ message: 'Não autorizado, token inválido.' });
    }
};

// Middleware para autorizar roles específicas
exports.authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ message: `Acesso negado. Usuário com a role '${req.user.role}' não tem permissão para esta ação.` });
        }
        next();
    };
};

// --- Funções de Autenticação e Usuário Geral ---

// @desc    Registrar novo usuário
// @route   POST /api/register
// @access  Public
exports.register = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        let user = await User.findOne({ $or: [{ username }, { email }] });
        if (user) {
            return res.status(400).json({ message: 'Nome de usuário ou email já registrado.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        user = await User.create({
            username,
            email,
            password: hashedPassword
        });

        const token = generateToken(user._id);

        res.status(201).json({
            message: 'Usuário registrado com sucesso!',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                balance: user.balance,
                avatar: user.avatar,
                role: user.role
            }
        });

    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({ message: 'Erro no servidor. Tente novamente mais tarde.' });
    }
};

// @desc    Autenticar usuário e obter token
// @route   POST /api/login
// @access  Public
exports.login = async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(400).json({ message: 'Credenciais inválidas.' });
        }

        if (user.isBlocked) {
            return res.status(403).json({ message: 'Sua conta está bloqueada. Entre em contato com o suporte.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ message: 'Credenciais inválidas.' });
        }

        const token = generateToken(user._id);

        res.status(200).json({
            message: 'Login realizado com sucesso!',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                balance: user.balance,
                avatar: user.avatar,
                role: user.role
            }
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ message: 'Erro no servidor. Tente novamente mais tarde.' });
    }
};

// @desc    Solicitar recuperação de senha
// @route   POST /api/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado com este email.' });
        }

        // Gerar código de 6 dígitos
        const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
        const resetExpires = Date.now() + 10 * 60 * 1000; // 10 minutos de validade

        user.passwordResetCode = resetCode;
        user.passwordResetExpires = resetExpires;
        await user.save();

        // Enviar email estilizado
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: user.email,
            subject: 'BrainSkill - Recuperação de Senha',
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px;">
                    <h2 style="color: #4CAF50; text-align: center;">BrainSkill - Recuperação de Senha</h2>
                    <p>Olá ${user.username},</p>
                    <p>Recebemos uma solicitação de recuperação de senha para sua conta BrainSkill.</p>
                    <p>Seu código de recuperação é:</p>
                    <h3 style="background-color: #f2f2f2; padding: 10px; border-radius: 5px; text-align: center; font-size: 24px; letter-spacing: 5px;">${resetCode}</h3>
                    <p>Este código é válido por 10 minutos.</p>
                    <p>Se você não solicitou esta recuperação, por favor, ignore este email.</p>
                    <p>Obrigado,<br>A Equipe BrainSkill</p>
                    <p style="font-size: 0.8em; color: #888; text-align: center;">Este é um email automático, por favor, não responda.</p>
                </div>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Erro ao enviar email:', error);
                return res.status(500).json({ message: 'Erro ao enviar o email de recuperação. Tente novamente mais tarde.' });
            }
            console.log('Email enviado:', info.response);
            res.status(200).json({ message: 'Um código de recuperação foi enviado para o seu email.' });
        });

    } catch (error) {
        console.error('Erro em forgotPassword:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Redefinir senha usando o código
// @route   POST /api/reset-password
// @access  Public
exports.resetPassword = async (req, res) => {
    const { email, code, newPassword } = req.body;

    try {
        const user = await User.findOne({
            email,
            passwordResetCode: code,
            passwordResetExpires: { $gt: Date.now() } // Verifica se o código ainda é válido
        });

        if (!user) {
            return res.status(400).json({ message: 'Código de recuperação inválido ou expirado.' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.passwordResetCode = undefined; // Limpa o código
        user.passwordResetExpires = undefined; // Limpa a validade
        await user.save();

        res.status(200).json({ message: 'Sua senha foi redefinida com sucesso!' });

    } catch (error) {
        console.error('Erro em resetPassword:', error);
        res.status(500).json({ message: 'Erro no servidor. Tente novamente mais tarde.' });
    }
};

// @desc    Obter perfil do usuário logado
// @route   GET /api/profile
// @access  Private
exports.getProfile = async (req, res) => {
    try {
        // req.user já vem populado pelo middleware `protect`
        res.status(200).json({
            id: req.user._id,
            username: req.user.username,
            email: req.user.email,
            balance: req.user.balance,
            avatar: req.user.avatar,
            role: req.user.role,
            createdAt: req.user.createdAt
        });
    } catch (error) {
        console.error('Erro ao obter perfil:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Atualizar perfil do usuário logado
// @route   PUT /api/profile
// @access  Private
exports.updateProfile = async (req, res) => {
    const { username, email, oldPassword, newPassword } = req.body;
    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (username && username !== user.username) {
            const existingUser = await User.findOne({ username });
            if (existingUser && String(existingUser._id) !== String(user._id)) {
                return res.status(400).json({ message: 'Este nome de usuário já está em uso.' });
            }
            user.username = username;
        }

        if (email && email !== user.email) {
            const existingUser = await User.findOne({ email });
            if (existingUser && String(existingUser._id) !== String(user._id)) {
                return res.status(400).json({ message: 'Este email já está em uso.' });
            }
            user.email = email;
        }

        if (oldPassword && newPassword) {
            const isMatch = await bcrypt.compare(oldPassword, user.password);
            if (!isMatch) {
                return res.status(400).json({ message: 'Senha antiga incorreta.' });
            }
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(newPassword, salt);
        } else if (newPassword) {
            return res.status(400).json({ message: 'Para alterar a senha, você deve fornecer a senha antiga.' });
        }

        await user.save();

        res.status(200).json({
            message: 'Perfil atualizado com sucesso!',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                balance: user.balance,
                avatar: user.avatar,
                role: user.role,
                createdAt: user.createdAt
            }
        });

    } catch (error) {
        console.error('Erro ao atualizar perfil:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Upload de avatar do usuário
// @route   POST /api/upload-avatar
// @access  Private
exports.uploadAvatar = async (req, res) => {
    try {
        if (!req.files || !req.files.avatar) {
            return res.status(400).json({ message: 'Nenhum arquivo de avatar enviado.' });
        }

        const avatarFile = req.files.avatar; // 'avatar' é o nome do campo no formulário FormData

        // Upload para o Cloudinary
        const result = await cloudinary.uploader.upload(avatarFile.tempFilePath, {
            folder: 'brainskill_avatars',
            width: 150,
            height: 150,
            crop: 'fill'
        });

        const user = await User.findById(req.user._id);
        user.avatar = result.secure_url;
        await user.save();

        res.status(200).json({
            message: 'Avatar atualizado com sucesso!',
            avatarUrl: user.avatar
        });

    } catch (error) {
        console.error('Erro ao fazer upload do avatar:', error);
        res.status(500).json({ message: 'Erro ao fazer upload do avatar. Tente novamente mais tarde.' });
    }
};

// @desc    Obter ranking de jogadores (usuários)
// @route   GET /api/ranking
// @access  Private (pode ser público se o requisito mudar)
exports.getRanking = async (req, res) => {
    try {
        const users = await User.find({ role: 'user' })
                                .select('username avatar balance createdAt')
                                .sort({ balance: -1 }) // Exemplo: ordenar por saldo
                                .limit(50); // Limitar para não sobrecarregar

        res.status(200).json({ users });
    } catch (error) {
        console.error('Erro ao obter ranking:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// --- Funções de Saldo e Transações ---

// @desc    Obter saldo atual do usuário
// @route   GET /api/balance
// @access  Private
exports.getBalance = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('balance');
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        res.status(200).json({ balance: user.balance });
    } catch (error) {
        console.error('Erro ao obter saldo:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Solicitar depósito
// @route   POST /api/deposit-request
// @access  Private
exports.requestDeposit = async (req, res) => {
    const { amount, method, phoneNumber } = req.body;

    // TODO: Adicionar validação de limites de depósito do Setting Model
    try {
        const deposit = await Deposit.create({
            user: req.user._id,
            amount,
            method,
            phoneNumber
        });

        res.status(201).json({ message: 'Pedido de depósito enviado com sucesso! Aguardando aprovação.', deposit });
    } catch (error) {
        console.error('Erro ao solicitar depósito:', error);
        res.status(500).json({ message: 'Erro ao processar o pedido de depósito.' });
    }
};

// @desc    Solicitar levantamento
// @route   POST /api/withdraw-request
// @access  Private
exports.requestWithdrawal = async (req, res) => {
    const { amount, method, phoneNumber } = req.body;

    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        // TODO: Adicionar validação de limites de levantamento do Setting Model
        if (user.balance < amount) {
            return res.status(400).json({ message: 'Saldo insuficiente para este levantamento.' });
        }

        const withdrawal = await Withdrawal.create({
            user: req.user._id,
            amount,
            method,
            phoneNumber
        });

        // O saldo só é deduzido após a aprovação pelo admin,
        // mas podemos bloquear o valor para evitar gastos duplos.
        // Por simplicidade aqui, o saldo é apenas verificado.
        // Em um sistema real, você teria um estado "pending_withdrawal" ou similar.

        res.status(201).json({ message: 'Pedido de levantamento enviado com sucesso! Aguardando aprovação.', withdrawal });
    } catch (error) {
        console.error('Erro ao solicitar levantamento:', error);
        res.status(500).json({ message: 'Erro ao processar o pedido de levantamento.' });
    }
};

// @desc    Obter histórico de transações (depósitos e levantamentos) do usuário
// @route   GET /api/transactions/history
// @access  Private
exports.getTransactionHistory = async (req, res) => {
    try {
        const deposits = await Deposit.find({ user: req.user._id }).sort({ createdAt: -1 });
        const withdrawals = await Withdrawal.find({ user: req.user._id }).sort({ createdAt: -1 });

        // Combina e ordena por data
        const history = [...deposits, ...withdrawals].sort((a, b) => b.createdAt - a.createdAt);

        res.status(200).json({ history });
    } catch (error) {
        console.error('Erro ao obter histórico de transações:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// --- Funções de Jogo e Lobby ---

// @desc    Obter salas de lobby abertas
// @route   GET /api/lobby
// @access  Private
exports.getOpenLobbyRooms = async (req, res) => {
    try {
        const openLobbies = await LobbyRoom.find({ status: 'open' })
                                        .populate('creator', 'username avatar') // Popula o criador
                                        .sort({ createdAt: -1 });

        res.status(200).json({ lobbies: openLobbies });
    } catch (error) {
        console.error('Erro ao obter salas do lobby:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Criar uma nova sala de lobby com aposta
// @route   POST /api/lobby/create
// @access  Private
exports.createLobbyRoom = async (req, res) => {
    const { betAmount, message } = req.body;

    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        // TODO: Obter limites de aposta do Setting Model
        // if (betAmount < MIN_BET || betAmount > MAX_BET) {
        //     return res.status(400).json({ message: 'Valor da aposta fora dos limites.' });
        // }

        if (user.balance < betAmount) {
            return res.status(400).json({ message: 'Saldo insuficiente para criar esta aposta.' });
        }

        // Debita o valor da aposta do criador imediatamente
        user.balance -= betAmount;
        await user.save();

        const lobby = await LobbyRoom.create({
            creator: req.user._id,
            betAmount,
            message
        });

        res.status(201).json({ message: 'Aposta criada no lobby com sucesso!', lobbyId: lobby._id });
    } catch (error) {
        console.error('Erro ao criar sala de lobby:', error);
        res.status(500).json({ message: 'Erro ao criar a aposta no lobby.' });
    }
};

// @desc    Aceitar uma aposta no lobby e iniciar uma partida
// @route   POST /api/lobby/:roomId/join
// @access  Private
exports.joinLobbyRoom = async (req, res) => {
    const { roomId } = req.params;

    try {
        const lobby = await LobbyRoom.findById(roomId);

        if (!lobby) {
            return res.status(404).json({ message: 'Sala de lobby não encontrada.' });
        }
        if (lobby.status !== 'open') {
            return res.status(400).json({ message: 'Esta aposta não está mais disponível.' });
        }
        if (String(lobby.creator) === String(req.user._id)) {
            return res.status(400).json({ message: 'Você não pode entrar na sua própria aposta.' });
        }

        const player2 = await User.findById(req.user._id);
        const player1 = await User.findById(lobby.creator); // O criador é o Player 1

        if (!player2 || !player1) {
            return res.status(404).json({ message: 'Um dos jogadores não foi encontrado.' });
        }

        if (player2.balance < lobby.betAmount) {
            return res.status(400).json({ message: 'Saldo insuficiente para aceitar esta aposta.' });
        }

        // Debita o valor da aposta do segundo jogador
        player2.balance -= lobby.betAmount;
        await player2.save();

        // Inicializa o tabuleiro de damas (8x8)
        const initialBoard = [
            ['b', 'b', 'b', 'b', 'b', 'b', 'b', 'b'],
            ['b', 'b', 'b', 'b', 'b', 'b', 'b', 'b'],
            ['b', 'b', 'b', 'b', 'b', 'b', 'b', 'b'],
            [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
            [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
            ['w', 'w', 'w', 'w', 'w', 'w', 'w', 'w'],
            ['w', 'w', 'w', 'w', 'w', 'w', 'w', 'w'],
            ['w', 'w', 'w', 'w', 'w', 'w', 'w', 'w'],
        ];

        // Criar o jogo
        const game = await Game.create({
            players: [player1._id, player2._id],
            boardState: initialBoard,
            currentPlayer: player1._id, // O criador (player1) começa
            betAmount: lobby.betAmount,
            status: 'in-progress'
        });

        lobby.status = 'in-game';
        lobby.gameId = game._id;
        await lobby.save();

        res.status(200).json({
            message: 'Partida iniciada com sucesso!',
            gameId: game._id,
            players: [{
                id: player1._id,
                username: player1.username,
                avatar: player1.avatar
            }, {
                id: player2._id,
                username: player2.username,
                avatar: player2.avatar
            }],
            initialBoard: game.boardState,
            currentPlayer: game.currentPlayer
        });

        // TODO: Emitir evento WebSocket para notificar ambos os jogadores sobre o início da partida
        // Isso será feito no server.js após a integração do socket.io

    } catch (error) {
        console.error('Erro ao entrar na sala de lobby:', error);
        res.status(500).json({ message: 'Erro ao entrar na aposta e iniciar a partida.' });
    }
};

// @desc    Obter histórico de partidas jogadas pelo usuário
// @route   GET /api/games/history
// @access  Private
exports.getGameHistory = async (req, res) => {
    try {
        const games = await Game.find({ players: req.user._id })
                                .populate('players', 'username avatar')
                                .populate('winner', 'username')
                                .populate('loser', 'username')
                                .sort({ createdAt: -1 })
                                .limit(20); // Limitar resultados

        res.status(200).json({ games });
    } catch (error) {
        console.error('Erro ao obter histórico de jogos:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Obter resultado de uma partida específica
// @route   GET /api/game/:gameId/result
// @access  Private
exports.getGameResult = async (req, res) => {
    const { gameId } = req.params;
    try {
        const game = await Game.findById(gameId)
                                .populate('players', 'username avatar')
                                .populate('winner', 'username')
                                .populate('loser', 'username');

        if (!game) {
            return res.status(404).json({ message: 'Partida não encontrada.' });
        }
        if (!game.players.some(p => String(p._id) === String(req.user._id))) {
            return res.status(403).json({ message: 'Você não tem permissão para ver os detalhes desta partida.' });
        }
        if (game.status !== 'completed') {
            return res.status(400).json({ message: 'Esta partida ainda não foi concluída.' });
        }

        res.status(200).json({ game });
    } catch (error) {
        console.error('Erro ao obter resultado da partida:', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// --- Lógica de Jogo de Damas (no backend) ---
// Estas funções são chamadas via WebSocket, mas a lógica de validação reside aqui.

/**
 * Representa um tabuleiro de damas.
 * ' ' = vazio
 * 'w' = peça branca
 * 'b' = peça preta
 * 'W' = dama branca
 * 'B' = dama preta
 */

const BOARD_SIZE = 8;

// Função auxiliar para verificar se a posição é válida no tabuleiro
const isValidPosition = (r, c) => {
    return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
};

// Função auxiliar para obter a peça na posição
const getPiece = (board, r, c) => {
    if (!isValidPosition(r, c)) return null;
    return board[r][c];
};

// Função auxiliar para verificar a cor da peça
const getPieceColor = (piece) => {
    if (piece === 'w' || piece === 'W') return 'white';
    if (piece === 'b' || piece === 'B') return 'black';
    return null;
};

// Função auxiliar para determinar a direção de movimento de acordo com a cor
const getMoveDirections = (color) => {
    return color === 'white' ? [-1] : [1]; // -1 para cima (Brancas), 1 para baixo (Pretas)
};

// Função para verificar movimentos válidos (não captura)
const getValidMoves = (board, r, c) => {
    const moves = [];
    const piece = getPiece(board, r, c);
    const color = getPieceColor(piece);

    if (!color) return moves;

    const isKing = (piece === 'W' || piece === 'B');
    const directions = isKing ? [-1, 1] : getMoveDirections(color);

    for (const dr of directions) {
        const newR = r + dr;
        // Movimento normal: diagonal esquerda e direita
        if (isValidPosition(newR, c - 1) && getPiece(board, newR, c - 1) === ' ') {
            moves.push({ from: { r, c }, to: { r: newR, c: c - 1 } });
        }
        if (isValidPosition(newR, c + 1) && getPiece(board, newR, c + 1) === ' ') {
            moves.push({ from: { r, c }, to: { r: newR, c: c + 1 } });
        }
    }
    return moves;
};


// Função para encontrar todas as capturas possíveis para uma peça em uma dada posição
const findCaptures = (board, r, c, color, isKing, currentCaptures = []) => {
    const captures = [];
    const opponentColor = color === 'white' ? 'black' : 'white';
    const directions = isKing ? [-1, 1] : getMoveDirections(color); // king can capture in all diagonal directions

    for (const dr of directions) {
        for (const dc of [-1, 1]) { // diagonals
            const opponentR = r + dr;
            const opponentC = c + dc;
            const landR = r + 2 * dr;
            const landC = c + 2 * dc;

            // Check if there's an opponent piece to jump over and landing spot is empty
            if (isValidPosition(opponentR, opponentC) && getPieceColor(getPiece(board, opponentR, opponentC)) === opponentColor &&
                isValidPosition(landR, landC) && getPiece(board, landR, landC) === ' ') {

                // Simulate the jump to check for further captures (multi-jump)
                const newBoard = JSON.parse(JSON.stringify(board)); // Deep copy
                const capturedPiece = newBoard[opponentR][opponentC];
                newBoard[landR][landC] = newBoard[r][c];
                newBoard[r][c] = ' ';
                newBoard[opponentR][opponentC] = ' '; // Remove captured piece

                const newCaptures = [...currentCaptures, { from: { r, c }, to: { r: landR, c: landC }, captured: { r: opponentR, c: opponentC, piece: capturedPiece } }];

                // For a regular piece, after a jump, it can only make further jumps in any direction
                // For a King, it can continue jumping from the landing spot
                const furtherCaptures = findCaptures(newBoard, landR, landC, color, isKing, newCaptures);

                if (furtherCaptures.length > 0) {
                    captures.push(...furtherCaptures);
                } else {
                    captures.push(newCaptures);
                }
            }
        }
    }

    return captures;
};


// Função para obter todas as capturas possíveis para o jogador
const getAllPossibleCaptures = (board, playerColor) => {
    let allCaptures = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPiece(board, r, c);
            const color = getPieceColor(piece);
            if (color === playerColor) {
                const isKing = (piece === 'W' || piece === 'B');
                const pieceCaptures = findCaptures(board, r, c, color, isKing);
                if (pieceCaptures.length > 0) {
                    allCaptures.push(...pieceCaptures);
                }
            }
        }
    }

    // Filtrar para encontrar a sequência de captura mais longa
    if (allCaptures.length === 0) return [];

    let maxCapturesLength = 0;
    allCaptures.forEach(seq => {
        if (seq.length > maxCapturesLength) {
            maxCapturesLength = seq.length;
        }
    });

    // Retorna apenas as sequências de captura com o maior número de peças capturadas
    return allCaptures.filter(seq => seq.length === maxCapturesLength);
};


// Função principal para validar um movimento
exports.validateMove = (game, from, to, playerColor) => {
    const board = game.boardState;
    const fromR = from.row;
    const fromC = from.col;
    const toR = to.row;
    const toC = to.col;

    const piece = getPiece(board, fromR, fromC);
    const pieceColor = getPieceColor(piece);

    // 1. Verificar se a peça existe e pertence ao jogador atual
    if (!piece || pieceColor !== playerColor) {
        return { isValid: false, message: 'Nenhuma peça ou peça inválida na origem, ou não é a sua vez.' };
    }

    // 2. Verificar se a posição de destino é válida e vazia
    if (!isValidPosition(toR, toC) || getPiece(board, toR, toC) !== ' ') {
        return { isValid: false, message: 'Posição de destino inválida ou ocupada.' };
    }

    const isKing = (piece === 'W' || piece === 'B');
    const dr = toR - fromR;
    const dc = toC - fromC;
    const absDr = Math.abs(dr);
    const absDc = Math.abs(dc);

    // Determinar a direção de movimento permitida para peças normais
    const allowedMoveDirection = playerColor === 'white' ? -1 : 1; // -1 para brancas (para cima), 1 para pretas (para baixo)

    // Encontrar todas as capturas possíveis para o jogador
    const possibleCaptures = getAllPossibleCaptures(board, playerColor);

    // 3. Prioridade de Captura: Se houver capturas obrigatórias, o movimento deve ser uma captura
    if (possibleCaptures.length > 0) {
        let isCurrentMoveACapture = false;
        let selectedCaptureSequence = null;

        for (const seq of possibleCaptures) {
            // Uma sequência de captura começa de uma posição 'from' e o primeiro salto vai para uma posição 'to'.
            // Precisamos verificar se o 'from' e o 'to' do movimento atual correspondem ao primeiro salto de uma sequência de captura.
            const firstJump = seq[0];
            if (firstJump && firstJump.from.r === fromR && firstJump.from.c === fromC &&
                firstJump.to.r === toR && firstJump.to.c === toC) {
                isCurrentMoveACapture = true;
                selectedCaptureSequence = seq; // Armazena a sequência completa da captura selecionada
                break;
            }
        }

        if (!isCurrentMoveACapture) {
            return { isValid: false, message: 'Captura é obrigatória. Você deve realizar uma captura.' };
        }

        // Se é uma captura, o movimento é válido, e você pode aplicar a primeira parte da sequência
        // A lógica de múltiplos saltos será gerenciada no frontend (e confirmada no backend)
        // para garantir que o jogador continue a sequência de saltos, se aplicável.
        // O `applyMove` fará a mudança de estado e remoção da peça capturada.
        return {
            isValid: true,
            isCapture: true,
            captured: [{ r: selectedCaptureSequence[0].captured.r, c: selectedCaptureSequence[0].captured.c }], // Apenas a peça capturada no primeiro salto
            nextJumps: selectedCaptureSequence.length > 1 ? selectedCaptureSequence.slice(1) : [] // Próximos saltos na sequência
        };
    }

    // 4. Movimento Normal (se não houver capturas obrigatórias)
    if (absDr === 1 && absDc === 1) { // Movimento diagonal de uma casa
        if (!isKing && dr !== allowedMoveDirection) {
            return { isValid: false, message: 'Peão só pode mover-se para frente na diagonal.' };
        }
        return { isValid: true, isCapture: false };
    }

    // 5. Movimento de Dama (se for dama e não for captura) - Damas podem mover-se por várias casas na diagonal
    if (isKing && absDr === absDc && absDr > 1) {
        // Verificar se o caminho diagonal está livre (sem peças entre a origem e o destino)
        const stepR = dr / absDr; // +1 ou -1
        const stepC = dc / absDc; // +1 ou -1

        for (let i = 1; i < absDr; i++) {
            if (getPiece(board, fromR + i * stepR, fromC + i * stepC) !== ' ') {
                return { isValid: false, message: 'Caminho bloqueado por outra peça.' };
            }
        }
        return { isValid: true, isCapture: false };
    }

    // Se nenhuma das condições acima for atendida
    return { isValid: false, message: 'Movimento inválido.' };
};


// Função para aplicar um movimento no tabuleiro
exports.applyMove = (board, from, to) => {
    const newBoard = JSON.parse(JSON.stringify(board)); // Cria uma cópia profunda do tabuleiro
    const piece = newBoard[from.row][from.col];

    newBoard[to.row][to.col] = piece;
    newBoard[from.row][from.col] = ' ';

    const dr = to.row - from.row;
    const dc = to.col - from.col;

    // Se for uma captura (movimento de 2 casas na diagonal), remove a peça capturada
    if (Math.abs(dr) === 2 && Math.abs(dc) === 2) {
        const capturedR = from.row + dr / 2;
        const capturedC = from.col + dc / 2;
        newBoard[capturedR][capturedC] = ' '; // Remove a peça capturada
    }

    // Verificar se a peça virou Dama
    if (piece === 'w' && to.row === 0) {
        newBoard[to.row][to.col] = 'W'; // Dama Branca
    } else if (piece === 'b' && to.row === BOARD_SIZE - 1) {
        newBoard[to.row][to.col] = 'B'; // Dama Preta
    }

    return newBoard;
};


// Função para verificar se o jogo terminou
exports.checkGameEnd = (board, currentPlayerColor) => {
    let currentPlayerPieces = 0;
    let opponentPieces = 0;
    let hasValidMoves = false;

    const opponentColor = currentPlayerColor === 'white' ? 'black' : 'white';

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPiece(board, r, c);
            const color = getPieceColor(piece);

            if (color === currentPlayerColor) {
                currentPlayerPieces++;
                // Verifica se há qualquer movimento ou captura possível para o jogador atual
                if (getValidMoves(board, r, c).length > 0 || getAllPossibleCaptures(board, currentPlayerColor).length > 0) {
                    hasValidMoves = true;
                }
            } else if (color === opponentColor) {
                opponentPieces++;
            }
        }
    }

    if (currentPlayerPieces === 0) {
        return { gameOver: true, reason: 'Sem peças', winnerColor: opponentColor };
    }
    if (!hasValidMoves) {
        return { gameOver: true, reason: 'Sem movimentos válidos', winnerColor: opponentColor };
    }
    // TODO: Adicionar lógica para empate (ex: 100 movimentos sem captura/avanço de peão)

    return { gameOver: false };
};


// --- Funções Administrativas ---

// @desc    Obter todos os usuários (Admin)
// @route   GET /api/admin/users
// @access  Private (Admin only)
exports.adminGetAllUsers = async (req, res) => {
    try {
        const users = await User.find().select('-password'); // Não enviar senhas
        res.status(200).json({ users });
    } catch (error) {
        console.error('Erro ao obter todos os usuários (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Bloquear conta de usuário (Admin)
// @route   PUT /api/admin/users/:userId/block
// @access  Private (Admin only)
exports.adminBlockUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        if (user.role === 'admin') {
            return res.status(403).json({ message: 'Não é possível bloquear um administrador.' });
        }

        user.isBlocked = true;
        await user.save();
        res.status(200).json({ message: `Usuário ${user.username} bloqueado com sucesso.` });
    } catch (error) {
        console.error('Erro ao bloquear usuário (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Desbloquear conta de usuário (Admin)
// @route   PUT /api/admin/users/:userId/unblock
// @access  Private (Admin only)
exports.adminUnblockUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        user.isBlocked = false;
        await user.save();
        res.status(200).json({ message: `Usuário ${user.username} desbloqueado com sucesso.` });
    } catch (error) {
        console.error('Erro ao desbloquear usuário (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Adicionar/remover saldo manualmente (Admin)
// @route   PUT /api/admin/users/:userId/balance
// @access  Private (Admin only)
exports.adminUpdateUserBalance = async (req, res) => {
    const { amount, type } = req.body; // type: 'add' ou 'subtract'

    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ message: 'Valor inválido. Deve ser um número positivo.' });
    }
    if (!['add', 'subtract'].includes(type)) {
        return res.status(400).json({ message: 'Tipo de operação inválido. Use "add" ou "subtract".' });
    }

    try {
        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (type === 'add') {
            user.balance += amount;
        } else { // 'subtract'
            if (user.balance < amount) {
                return res.status(400).json({ message: 'Não é possível subtrair, saldo insuficiente do usuário.' });
            }
            user.balance -= amount;
        }
        await user.save();

        res.status(200).json({ message: `Saldo do usuário ${user.username} atualizado. Novo saldo: ${user.balance}.` });
    } catch (error) {
        console.error('Erro ao atualizar saldo (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Visualizar pedidos de depósito (Admin)
// @route   GET /api/admin/deposits
// @access  Private (Admin only)
exports.adminGetDepositRequests = async (req, res) => {
    try {
        const deposits = await Deposit.find().populate('user', 'username email');
        res.status(200).json({ deposits });
    } catch (error) {
        console.error('Erro ao obter pedidos de depósito (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Aprovar pedido de depósito (Admin)
// @route   PUT /api/admin/deposits/:depositId/approve
// @access  Private (Admin only)
exports.adminApproveDeposit = async (req, res) => {
    try {
        const deposit = await Deposit.findById(req.params.depositId);
        if (!deposit) {
            return res.status(404).json({ message: 'Pedido de depósito não encontrado.' });
        }
        if (deposit.status !== 'pending') {
            return res.status(400).json({ message: 'Este depósito já foi processado.' });
        }

        const user = await User.findById(deposit.user);
        if (!user) {
            return res.status(404).json({ message: 'Usuário associado ao depósito não encontrado.' });
        }

        user.balance += deposit.amount;
        deposit.status = 'approved';
        deposit.processedAt = Date.now();
        // deposit.adminNotes = req.body.notes || ''; // Opcional: admin pode adicionar notas

        await user.save();
        await deposit.save();

        res.status(200).json({ message: 'Depósito aprovado com sucesso!', deposit });
    } catch (error) {
        console.error('Erro ao aprovar depósito (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Rejeitar pedido de depósito (Admin)
// @route   PUT /api/admin/deposits/:depositId/reject
// @access  Private (Admin only)
exports.adminRejectDeposit = async (req, res) => {
    try {
        const deposit = await Deposit.findById(req.params.depositId);
        if (!deposit) {
            return res.status(404).json({ message: 'Pedido de depósito não encontrado.' });
        }
        if (deposit.status !== 'pending') {
            return res.status(400).json({ message: 'Este depósito já foi processado.' });
        }

        deposit.status = 'rejected';
        deposit.processedAt = Date.now();
        deposit.adminNotes = req.body.notes || 'Rejeitado pelo administrador.';

        await deposit.save();

        res.status(200).json({ message: 'Depósito rejeitado com sucesso!', deposit });
    } catch (error) {
        console.error('Erro ao rejeitar depósito (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Visualizar pedidos de levantamento (Admin)
// @route   GET /api/admin/withdrawals
// @access  Private (Admin only)
exports.adminGetWithdrawalRequests = async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find().populate('user', 'username email');
        res.status(200).json({ withdrawals });
    } catch (error) {
        console.error('Erro ao obter pedidos de levantamento (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Aprovar pedido de levantamento (Admin)
// @route   PUT /api/admin/withdrawals/:withdrawalId/approve
// @access  Private (Admin only)
exports.adminApproveWithdrawal = async (req, res) => {
    try {
        const withdrawal = await Withdrawal.findById(req.params.withdrawalId);
        if (!withdrawal) {
            return res.status(404).json({ message: 'Pedido de levantamento não encontrado.' });
        }
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ message: 'Este levantamento já foi processado.' });
        }

        const user = await User.findById(withdrawal.user);
        if (!user) {
            return res.status(404).json({ message: 'Usuário associado ao levantamento não encontrado.' });
        }

        if (user.balance < withdrawal.amount) {
            // Isso pode acontecer se o usuário gastou o dinheiro antes da aprovação
            // Um sistema mais robusto teria um estado de "saldo pendente de saque"
            withdrawal.status = 'rejected';
            withdrawal.adminNotes = 'Saldo insuficiente do usuário no momento da aprovação.';
            await withdrawal.save();
            return res.status(400).json({ message: 'Erro: Saldo insuficiente do usuário para este levantamento. Levantamento rejeitado automaticamente.' });
        }

        user.balance -= withdrawal.amount;
        withdrawal.status = 'approved';
        withdrawal.processedAt = Date.now();
        // withdrawal.adminNotes = req.body.notes || ''; // Opcional: admin pode adicionar notas

        await user.save();
        await withdrawal.save();

        res.status(200).json({ message: 'Levantamento aprovado com sucesso!', withdrawal });
    } catch (error) {
        console.error('Erro ao aprovar levantamento (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Rejeitar pedido de levantamento (Admin)
// @route   PUT /api/admin/withdrawals/:withdrawalId/reject
// @access  Private (Admin only)
exports.adminRejectWithdrawal = async (req, res) => {
    try {
        const withdrawal = await Withdrawal.findById(req.params.withdrawalId);
        if (!withdrawal) {
            return res.status(404).json({ message: 'Pedido de levantamento não encontrado.' });
        }
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ message: 'Este levantamento já foi processado.' });
        }

        withdrawal.status = 'rejected';
        withdrawal.processedAt = Date.now();
        withdrawal.adminNotes = req.body.notes || 'Rejeitado pelo administrador.';

        await withdrawal.save();

        res.status(200).json({ message: 'Levantamento rejeitado com sucesso!', withdrawal });
    } catch (error) {
        console.error('Erro ao rejeitar levantamento (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Visualizar partidas ao vivo ou encerradas (Admin)
// @route   GET /api/admin/games
// @access  Private (Admin only)
exports.adminGetAllGames = async (req, res) => {
    try {
        const games = await Game.find()
                                .populate('players', 'username avatar')
                                .populate('winner', 'username')
                                .populate('loser', 'username')
                                .sort({ createdAt: -1 });
        res.status(200).json({ games });
    } catch (error) {
        console.error('Erro ao obter todas as partidas (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Obter estatísticas da plataforma (Admin)
// @route   GET /api/admin/stats
// @access  Private (Admin only)
exports.adminGetPlatformStats = async (req, res) => {
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

        // Total ganho em partidas (para usuários) e comissão da plataforma
        // A comissão é 10% do valor ganho por um usuário.
        // O valor ganho é o betAmount da partida vencedora.
        const platformCommissionRate = 0.10; // 10%

        const gamesCompleted = await Game.find({ status: 'completed', winner: { $ne: null } });

        let totalUserWinnings = 0;
        let totalPlatformCommission = 0;

        gamesCompleted.forEach(game => {
            // O ganhador recebe o dobro do valor apostado (betAmount)
            // A comissão é sobre o que o usuário GANHA (betAmount), não o total do pote.
            // Ex: Aposta 100, ganha 200. Lucro é 100. Comissão é 10% de 100 = 10.
            totalUserWinnings += game.betAmount; // Cada vencedor "ganha" o valor apostado pelo perdedor
            totalPlatformCommission += game.betAmount * platformCommissionRate;
        });


        res.status(200).json({
            totalDeposited,
            totalWithdrawn,
            totalUserWinnings: parseFloat(totalUserWinnings.toFixed(2)),
            totalPlatformCommission: parseFloat(totalPlatformCommission.toFixed(2))
        });
    } catch (error) {
        console.error('Erro ao obter estatísticas da plataforma (Admin):', error);
        res.status(500).json({ message: 'Erro no servidor.' });
    }
};

// @desc    Definir/Atualizar configurações do sistema (Admin)
// @route   POST /api/admin/settings
// @access  Private (Admin only)
exports.adminUpdateSetting = async (req, res) => {
    const { name, value, description } = req.body;

    if (!name || value === undefined) {
        return res.status(400).json({ message: 'Nome e valor da configuração são obrigatórios.' });
    }

    try {
        let setting = await Setting.findOneAndUpdate(
            { name },
            { value, description },
            { upsert: true, new: true, setDefaultsOnInsert: true } // Cria se não existir, retorna o novo doc
        );
        res.status(200).json({ message: `Configuração '${name}' atualizada com sucesso!`, setting });
    } catch (error) {
        console.error('Erro ao atualizar configuração (Admin):', error);
        res.status(500).json({ message: 'Erro ao atualizar a configuração.' });
    }
};

// @desc    Obter todas as configurações do sistema (Admin)
// @route   GET /api/admin/settings
// @access  Private (Admin only)
exports.adminGetSettings = async (req, res) => {
    try {
        const settings = await Setting.find({});
        res.status(200).json({ settings });
    } catch (error) {
        console.error('Erro ao obter configurações (Admin):', error);
        res.status(500).json({ message: 'Erro ao obter as configurações.' });
    }
};


/*
Para executar este arquivo localmente:

Este arquivo é um módulo que contém a lógica de negócios e será importado por `routes.js` e `server.js`.
Não há necessidade de executá-lo diretamente.

Certifique-se de que os seguintes pacotes estejam instalados:
`npm install mongoose bcryptjs jsonwebtoken nodemailer cloudinary multer-storage-cloudinary express-fileupload dotenv`

E que as variáveis de ambiente `.env` estejam configuradas:
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `EMAIL_HOST`
- `EMAIL_PORT`
- `EMAIL_SECURE`
- `EMAIL_USER`
- `EMAIL_PASS`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `MONGODB_URI`
*/