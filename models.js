// models.js

const mongoose = require('mongoose');

// --- User Model ---
const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    password: {
        type: String,
        required: true
    },
    balance: {
        type: Number,
        default: 0
    },
    avatar: {
        type: String,
        default: 'https://res.cloudinary.com/your-cloud-name/image/upload/v1/default_avatar.png' // Placeholder, replace with actual default
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    isBlocked: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    passwordResetCode: {
        type: String,
        default: null
    },
    passwordResetExpires: {
        type: Date,
        default: null
    }
});

const User = mongoose.model('User', userSchema);

// --- Game Model ---
const gameSchema = new mongoose.Schema({
    players: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }],
    boardState: {
        type: Array, // Represents the 8x8 board, e.g., [[' ', 'w', ' ', ...], ...]
        required: true
    },
    currentPlayer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    winner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    loser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    status: {
        type: String,
        enum: ['pending', 'in-progress', 'completed', 'cancelled'],
        default: 'pending'
    },
    betAmount: {
        type: Number,
        required: true
    },
    moves: [{
        player: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        from: {
            row: Number,
            col: Number
        },
        to: {
            row: Number,
            col: Number
        },
        capturedPieces: [String], // e.g., ['b_pawn_0', 'b_pawn_1']
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    completedAt: {
        type: Date,
        default: null
    }
});

const Game = mongoose.model('Game', gameSchema);

// --- Deposit Model ---
const depositSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    method: {
        type: String,
        enum: ['M-Pesa', 'e-Mola'],
        required: true
    },
    phoneNumber: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    processedAt: {
        type: Date,
        default: null
    },
    adminNotes: {
        type: String
    }
});

const Deposit = mongoose.model('Deposit', depositSchema);

// --- Withdrawal Model ---
const withdrawalSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    method: {
        type: String,
        enum: ['M-Pesa', 'e-Mola'],
        required: true
    },
    phoneNumber: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    processedAt: {
        type: Date,
        default: null
    },
    adminNotes: {
        type: String
    }
});

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- LobbyRoom Model ---
const lobbyRoomSchema = new mongoose.Schema({
    creator: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    betAmount: {
        type: Number,
        required: true
    },
    message: {
        type: String,
        trim: true,
        maxlength: 100
    },
    status: {
        type: String,
        enum: ['open', 'in-game', 'closed'],
        default: 'open'
    },
    gameId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Game',
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const LobbyRoom = mongoose.model('LobbyRoom', lobbyRoomSchema);

// --- Settings Model (for admin configurations) ---
const settingSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    value: {
        type: mongoose.Schema.Types.Mixed, // Can be number, string, boolean, etc.
        required: true
    },
    description: {
        type: String,
        trim: true
    }
});

const Setting = mongoose.model('Setting', settingSchema);


module.exports = {
    User,
    Game,
    Deposit,
    Withdrawal,
    LobbyRoom,
    Setting
};

/*
Para executar este arquivo localmente (apenas para teste de conexão com o MongoDB):

1. Certifique-se de ter o Node.js e o npm instalados.
2. Crie um arquivo `package.json` no mesmo diretório com `npm init -y`.
3. Instale as dependências: `npm install mongoose`
4. Crie um arquivo `.env` na raiz do projeto com sua string de conexão do MongoDB Atlas:
   `MONGODB_URI=sua_string_de_conexao_do_mongodb_atlas`
5. Adicione um script de teste ao seu `package.json` (ex: "test-models": "node models.js").
6. Execute `npm run test-models` no terminal.

Este arquivo é um módulo e será importado por `server.js` e `controllers.js`.
Não há necessidade de executar este arquivo diretamente em um ambiente de produção.
*/