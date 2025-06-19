// models.js
// Este arquivo define os esquemas do MongoDB para o projeto BrainSkill.

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // Para hash de senhas

// --- User Schema ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    avatar: { type: String, default: 'https://res.cloudinary.com/your_cloud_name/image/upload/v1/default_avatar.png' }, // Substitua 'your_cloud_name'
    balance: { type: Number, default: 0 },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    isBlocked: { type: Boolean, default: false },
    passwordResetCode: { type: String },
    passwordResetExpires: { type: Date },
    mPesaNumber: { type: String, trim: true },
    eMolaNumber: { type: String, trim: true },
    totalWins: { type: Number, default: 0 },
    totalLosses: { type: Number, default: 0 },
    totalGames: { type: Number, default: 0 },
    platformCommissionEarned: { type: Number, default: 0 } // Comissão ganha pelo usuário (10% de cada vitória)
}, { timestamps: true });

// Pré-save hook para hashear a senha antes de salvar
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Método para comparar senhas
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// --- Game Schema ---
const gameSchema = new mongoose.Schema({
    players: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        username: { type: String, required: true },
        color: { type: String, enum: ['white', 'black'], required: true }, // Cor das peças no jogo
        eloChange: { type: Number, default: 0 } // Se você for implementar sistema de ELO futuramente
    }],
    boardState: { type: String, required: true }, // JSON stringified representation of the board
    currentPlayer: { type: String, enum: ['white', 'black'], required: true },
    status: { type: String, enum: ['pending', 'in-progress', 'completed', 'cancelled'], default: 'pending' },
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    loser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    betAmount: { type: Number, required: true, min: 0 },
    moves: [{
        player: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        from: { type: String }, // Ex: 'a1'
        to: { type: String },   // Ex: 'b2'
        capturedPieces: [{ type: String }], // Ex: ['c3']
        timestamp: { type: Date, default: Date.now }
    }],
    startTime: { type: Date, default: Date.now },
    endTime: { type: Date },
    // Adicione um campo para armazenar o ID do lobby que gerou este jogo, se aplicável
    lobbyId: { type: mongoose.Schema.Types.ObjectId, ref: 'LobbyRoom' }
}, { timestamps: true });

// --- Deposit Schema ---
const depositSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['M-Pesa', 'e-Mola'], required: true },
    phoneNumber: { type: String, required: true, trim: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    transactionId: { type: String, unique: true, sparse: true }, // ID de transação real, se houver
    adminNotes: { type: String },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Admin que processou
    processedAt: { type: Date }
}, { timestamps: true });

// --- Withdrawal Schema ---
const withdrawalSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['M-Pesa', 'e-Mola'], required: true },
    phoneNumber: { type: String, required: true, trim: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    transactionId: { type: String, unique: true, sparse: true }, // ID de transação real, se houver
    adminNotes: { type: String },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Admin que processou
    processedAt: { type: Date }
}, { timestamps: true });

// --- LobbyRoom Schema ---
const lobbyRoomSchema = new mongoose.Schema({
    creator: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        username: { type: String, required: true }
    },
    betAmount: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['open', 'in-game', 'closed'], default: 'open' },
    shortDescription: { type: String, maxlength: 100 }, // Texto curto do criador
    opponent: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        username: { type: String }
    },
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' } // Opcional, linka com a partida após ser aceita
}, { timestamps: true });

// --- PlatformSettings Schema (para configurações admin) ---
const platformSettingsSchema = new mongoose.Schema({
    minDeposit: { type: Number, default: 50 },
    maxDeposit: { type: Number, default: 5000 },
    maxBet: { type: Number, default: 1000 },
    commissionRate: { type: Number, default: 0.10 }, // 10%
    gameRulesText: { type: String, default: "As regras do jogo de damas seguem o padrão brasileiro..." },
    platformName: { type: String, default: "BrainSkill" },
    contactEmail: { type: String, default: "support@brainskill.com" },
    // Adicione outras configurações globais aqui
}, { timestamps: true });


const User = mongoose.model('User', userSchema);
const Game = mongoose.model('Game', gameSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const LobbyRoom = mongoose.model('LobbyRoom', lobbyRoomSchema);
const PlatformSettings = mongoose.model('PlatformSettings', platformSettingsSchema);

module.exports = {
    User,
    Game,
    Deposit,
    Withdrawal,
    LobbyRoom,
    PlatformSettings
};

// Instruções básicas para rodar localmente:
// 1. Certifique-se de ter o MongoDB Atlas configurado e a string de conexão (URI) disponível.
// 2. No arquivo server.js, você conectará a este banco de dados usando essa URI.
// 3. Este arquivo define os modelos de dados. Eles serão usados pelos controllers para interagir com o MongoDB.