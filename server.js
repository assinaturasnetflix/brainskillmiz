const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Armazenamento em memória
const games = new Map();
const waitingPlayers = [];

class CheckersGame {
    constructor(gameId) {
        this.gameId = gameId;
        this.players = [];
        this.currentPlayer = 0; // 0 ou 1
        this.board = this.initializeBoard();
        this.gameState = 'waiting'; // waiting, playing, finished
        this.winner = null;
        this.moveHistory = [];
        this.playerTimes = [300000, 300000]; // 5 minutos cada
        this.moveStartTime = Date.now();
        this.moveTimeLimit = 30000; // 30 segundos por jogada
        this.mustCaptureFrom = null; // Para capturas múltiplas
    }

    initializeBoard() {
        const board = Array(8).fill(null).map(() => Array(8).fill(null));
        
        // Posicionar peças do jogador 1 (pretas) - linhas 0, 1, 2
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 8; col++) {
                if ((row + col) % 2 === 1) {
                    board[row][col] = { player: 1, isKing: false };
                }
            }
        }
        
        // Posicionar peças do jogador 2 (vermelhas) - linhas 5, 6, 7
        for (let row = 5; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if ((row + col) % 2 === 1) {
                    board[row][col] = { player: 0, isKing: false };
                }
            }
        }
        
        return board;
    }

    addPlayer(playerId, nickname) {
        if (this.players.length < 2) {
            this.players.push({ id: playerId, nickname, connected: true });
            if (this.players.length === 2) {
                this.gameState = 'playing';
                this.moveStartTime = Date.now();
            }
            return true;
        }
        return false;
    }

    getAllPossibleCaptures(player) {
        const captures = [];
        
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const piece = this.board[row][col];
                if (piece && piece.player === player) {
                    const pieceCaptures = this.getPieceCaptures(row, col);
                    captures.push(...pieceCaptures);
                }
            }
        }
        
        return captures;
    }

    getPieceCaptures(row, col) {
        const piece = this.board[row][col];
        const captures = [];
        
        if (!piece) return captures;
        
        const directions = piece.isKing ? 
            [[-1, -1], [-1, 1], [1, -1], [1, 1]] : 
            piece.player === 0 ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
        
        for (const [rowDir, colDir] of directions) {
            if (piece.isKing) {
                // Lógica para dama
                let foundEnemy = false;
                let enemyPos = null;
                
                for (let dist = 1; dist < 8; dist++) {
                    const checkRow = row + rowDir * dist;
                    const checkCol = col + colDir * dist;
                    
                    if (checkRow < 0 || checkRow > 7 || checkCol < 0 || checkCol > 7) break;
                    
                    const checkPiece = this.board[checkRow][checkCol];
                    
                    if (checkPiece) {
                        if (checkPiece.player === piece.player) {
                            break; // Peça própria, não pode passar
                        } else if (!foundEnemy) {
                            foundEnemy = true;
                            enemyPos = [checkRow, checkCol];
                        } else {
                            break; // Segunda peça, não pode capturar
                        }
                    } else if (foundEnemy) {
                        // Casa vazia após inimigo - captura válida
                        captures.push({
                            from: [row, col],
                            to: [checkRow, checkCol],
                            captured: enemyPos
                        });
                    }
                }
            } else {
                // Lógica para peão
                const captureRow = row + rowDir;
                const captureCol = col + colDir;
                const landRow = row + rowDir * 2;
                const landCol = col + colDir * 2;
                
                if (landRow >= 0 && landRow <= 7 && landCol >= 0 && landCol <= 7) {
                    const capturedPiece = this.board[captureRow][captureCol];
                    const landPiece = this.board[landRow][landCol];
                    
                    if (capturedPiece && 
                        capturedPiece.player !== piece.player && 
                        landPiece === null) {
                        captures.push({
                            from: [row, col],
                            to: [landRow, landCol],
                            captured: [captureRow, captureCol]
                        });
                    }
                }
            }
        }
        
        return captures;
    }

    isValidMove(fromRow, fromCol, toRow, toCol, playerId) {
        // Verificar se é a vez do jogador
        if (this.players[this.currentPlayer].id !== playerId) {
            return { valid: false, error: 'Não é sua vez' };
        }

        // Verificar se deve capturar de uma posição específica (capturas múltiplas)
        if (this.mustCaptureFrom && 
            (this.mustCaptureFrom[0] !== fromRow || this.mustCaptureFrom[1] !== fromCol)) {
            return { valid: false, error: 'Deve continuar capturando com a mesma peça' };
        }

        // Verificar limites do tabuleiro
        if (fromRow < 0 || fromRow > 7 || fromCol < 0 || fromCol > 7 ||
            toRow < 0 || toRow > 7 || toCol < 0 || toCol > 7) {
            return { valid: false, error: 'Movimento fora do tabuleiro' };
        }

        // Verificar se há peça na posição inicial
        const piece = this.board[fromRow][fromCol];
        if (!piece || piece.player !== this.currentPlayer) {
            return { valid: false, error: 'Peça inválida' };
        }

        // Verificar se a casa de destino está vazia e é preta
        if (this.board[toRow][toCol] !== null || (toRow + toCol) % 2 === 0) {
            return { valid: false, error: 'Casa de destino inválida' };
        }

        const rowDiff = toRow - fromRow;
        const colDiff = toCol - fromCol;
        const absRowDiff = Math.abs(rowDiff);
        const absColDiff = Math.abs(colDiff);

        // Verificar se o movimento é diagonal
        if (absRowDiff !== absColDiff) {
            return { valid: false, error: 'Movimento deve ser diagonal' };
        }

        // Verificar capturas obrigatórias (apenas se não estiver em captura múltipla)
        if (!this.mustCaptureFrom) {
            const captures = this.getAllPossibleCaptures(this.currentPlayer);
            if (captures.length > 0) {
                const isCapture = absRowDiff > 1;
                if (!isCapture) {
                    return { valid: false, error: 'Captura é obrigatória' };
                }
            }
        }

        // Validar movimento específico
        if (!piece.isKing) {
            // Movimento de peão
            const direction = this.currentPlayer === 0 ? -1 : 1;
            
            if (absRowDiff === 1) {
                // Movimento simples
                if (rowDiff !== direction) {
                    return { valid: false, error: 'Peão só move para frente' };
                }
                return { valid: true, isCapture: false };
            } else if (absRowDiff === 2) {
                // Captura
                const middleRow = fromRow + rowDiff / 2;
                const middleCol = fromCol + colDiff / 2;
                const capturedPiece = this.board[middleRow][middleCol];
                
                if (!capturedPiece || capturedPiece.player === this.currentPlayer) {
                    return { valid: false, error: 'Não há peça inimiga para capturar' };
                }
                
                return { 
                    valid: true, 
                    isCapture: true, 
                    capturedRow: middleRow, 
                    capturedCol: middleCol 
                };
            } else {
                return { valid: false, error: 'Peão não pode mover mais de 2 casas' };
            }
        } else {
            // Movimento de dama
            const rowStep = rowDiff > 0 ? 1 : -1;
            const colStep = colDiff > 0 ? 1 : -1;
            let capturedPieces = [];
            
            for (let i = 1; i < absRowDiff; i++) {
                const checkRow = fromRow + i * rowStep;
                const checkCol = fromCol + i * colStep;
                const checkPiece = this.board[checkRow][checkCol];
                
                if (checkPiece) {
                    if (checkPiece.player === this.currentPlayer) {
                        return { valid: false, error: 'Caminho bloqueado por peça própria' };
                    } else {
                        capturedPieces.push({ row: checkRow, col: checkCol });
                    }
                }
            }
            
            if (capturedPieces.length > 1) {
                return { valid: false, error: 'Não pode capturar múltiplas peças em linha' };
            }
            
            return { 
                valid: true, 
                isCapture: capturedPieces.length > 0,
                capturedRow: capturedPieces.length > 0 ? capturedPieces[0].row : null,
                capturedCol: capturedPieces.length > 0 ? capturedPieces[0].col : null
            };
        }
    }

    makeMove(fromRow, fromCol, toRow, toCol, playerId) {
        const validation = this.isValidMove(fromRow, fromCol, toRow, toCol, playerId);
        
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Executar movimento
        const piece = this.board[fromRow][fromCol];
        this.board[toRow][toCol] = piece;
        this.board[fromRow][fromCol] = null;

        let capturedPiece = null;
        let wasPromoted = false;
        
        if (validation.isCapture) {
            capturedPiece = this.board[validation.capturedRow][validation.capturedCol];
            this.board[validation.capturedRow][validation.capturedCol] = null;
        }

        // Promover a dama
        if (!piece.isKing) {
            if ((piece.player === 0 && toRow === 0) || (piece.player === 1 && toRow === 7)) {
                piece.isKing = true;
                wasPromoted = true;
            }
        }

        // Registrar movimento
        this.moveHistory.push({
            player: this.currentPlayer,
            from: [fromRow, fromCol],
            to: [toRow, toCol],
            captured: capturedPiece ? [validation.capturedRow, validation.capturedCol] : null,
            promoted: wasPromoted,
            timestamp: Date.now()
        });

        // Verificar capturas múltiplas
        if (validation.isCapture) {
            const additionalCaptures = this.getPieceCaptures(toRow, toCol);
            if (additionalCaptures.length > 0) {
                // Jogador deve continuar capturando
                this.mustCaptureFrom = [toRow, toCol];
                return { 
                    success: true, 
                    continueTurn: true, 
                    mustCaptureFrom: [toRow, toCol],
                    board: this.board,
                    currentPlayer: this.currentPlayer
                };
            }
        }

        // Resetar captura obrigatória e trocar turno
        this.mustCaptureFrom = null;
        this.currentPlayer = 1 - this.currentPlayer;
        this.moveStartTime = Date.now();

        // Verificar condições de vitória
        const winner = this.checkWinner();
        if (winner !== null) {
            this.gameState = 'finished';
            this.winner = winner;
        }

        return { 
            success: true, 
            continueTurn: false,
            board: this.board,
            currentPlayer: this.currentPlayer,
            winner: this.winner,
            gameState: this.gameState
        };
    }

    hasValidMoves(row, col) {
        const piece = this.board[row][col];
        if (!piece) return false;

        const directions = piece.isKing ? 
            [[-1, -1], [-1, 1], [1, -1], [1, 1]] : 
            piece.player === 0 ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];

        for (const [rowDir, colDir] of directions) {
            if (piece.isKing) {
                // Verificar movimentos de dama
                for (let dist = 1; dist < 8; dist++) {
                    const newRow = row + rowDir * dist;
                    const newCol = col + colDir * dist;
                    
                    if (newRow < 0 || newRow > 7 || newCol < 0 || newCol > 7) break;
                    if (this.board[newRow][newCol] !== null) break;
                    
                    return true; // Encontrou movimento válido
                }
            } else {
                // Verificar movimento simples de peão
                const newRow = row + rowDir;
                const newCol = col + colDir;
                
                if (newRow >= 0 && newRow <= 7 && newCol >= 0 && newCol <= 7) {
                    if (this.board[newRow][newCol] === null) {
                        return true;
                    }
                }
            }
            
            // Verificar captura
            const captures = this.getPieceCaptures(row, col);
            if (captures.length > 0) return true;
        }
        
        return false;
    }

    checkWinner() {
        let player0Pieces = 0;
        let player1Pieces = 0;
        let player0Moves = false;
        let player1Moves = false;

        // Contar peças e verificar movimentos possíveis
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const piece = this.board[row][col];
                if (piece) {
                    if (piece.player === 0) {
                        player0Pieces++;
                        if (!player0Moves && this.hasValidMoves(row, col)) {
                            player0Moves = true;
                        }
                    } else {
                        player1Pieces++;
                        if (!player1Moves && this.hasValidMoves(row, col)) {
                            player1Moves = true;
                        }
                    }
                }
            }
        }

        // Verificar condições de vitória
        if (player0Pieces === 0 || !player0Moves) return 1;
        if (player1Pieces === 0 || !player1Moves) return 0;
        
        return null;
    }

    disconnectPlayer(playerId) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== -1) {
            this.players[playerIndex].connected = false;
            
            // Se o jogo estava ativo, dar vitória ao oponente
            if (this.gameState === 'playing') {
                this.winner = 1 - playerIndex;
                this.gameState = 'finished';
            }
        }
    }

    resetGame() {
        this.board = this.initializeBoard();
        this.currentPlayer = 0;
        this.gameState = 'playing';
        this.winner = null;
        this.moveHistory = [];
        this.playerTimes = [300000, 300000];
        this.moveStartTime = Date.now();
        this.mustCaptureFrom = null;
    }

    getGameState() {
        return {
            gameId: this.gameId,
            players: this.players,
            currentPlayer: this.currentPlayer,
            board: this.board,
            gameState: this.gameState,
            winner: this.winner,
            playerTimes: this.playerTimes,
            mustCaptureFrom: this.mustCaptureFrom,
            moveHistory: this.moveHistory
        };
    }
}

// Função utilitária para gerar ID único
function generateGameId() {
    return Math.random().toString(36).substr(2, 9);
}

// Gerenciar conexões WebSocket
io.on('connection', (socket) => {
    console.log('Jogador conectado:', socket.id);

    // Entrar na fila ou criar jogo
    socket.on('findGame', (data) => {
        const { nickname } = data;
        
        if (!nickname || nickname.trim() === '') {
            socket.emit('error', { message: 'Nickname é obrigatório' });
            return;
        }

        // Verificar se há jogador esperando
        if (waitingPlayers.length > 0) {
            const waitingPlayer = waitingPlayers.shift();
            const gameId = generateGameId();
            
            const game = new CheckersGame(gameId);
            game.addPlayer(waitingPlayer.id, waitingPlayer.nickname);
            game.addPlayer(socket.id, nickname);
            
            games.set(gameId, game);
            
            // Adicionar jogadores às salas
            waitingPlayer.socket.join(gameId);
            socket.join(gameId);
            
            // Notificar início do jogo
            io.to(gameId).emit('gameFound', {
                gameId,
                gameState: game.getGameState()
            });
            
        } else {
            // Adicionar à fila
            waitingPlayers.push({
                id: socket.id,
                socket,
                nickname
            });
            
            socket.emit('waitingForPlayer');
        }
    });

    // Fazer movimento
    socket.on('makeMove', (data) => {
        const { gameId, fromRow, fromCol, toRow, toCol } = data;
        const game = games.get(gameId);
        
        if (!game) {
            socket.emit('error', { message: 'Jogo não encontrado' });
            return;
        }

        const result = game.makeMove(fromRow, fromCol, toRow, toCol, socket.id);
        
        if (result.success) {
            // Enviar atualização para ambos os jogadores
            io.to(gameId).emit('gameUpdate', {
                board: result.board,
                currentPlayer: result.currentPlayer,
                continueTurn: result.continueTurn,
                mustCaptureFrom: result.mustCaptureFrom,
                winner: result.winner,
                gameState: result.gameState
            });
            
            if (result.winner !== null) {
                io.to(gameId).emit('gameEnd', {
                    winner: result.winner,
                    winnerName: game.players[result.winner].nickname
                });
            }
        } else {
            socket.emit('moveError', { error: result.error });
        }
    });

    // Reiniciar jogo
    socket.on('restartGame', (data) => {
        const { gameId } = data;
        const game = games.get(gameId);
        
        if (!game) {
            socket.emit('error', { message: 'Jogo não encontrado' });
            return;
        }

        // Verificar se ambos os jogadores estão conectados
        const playerIndex = game.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) {
            socket.emit('error', { message: 'Você não está neste jogo' });
            return;
        }

        game.resetGame();
        
        io.to(gameId).emit('gameRestart', {
            gameState: game.getGameState()
        });
    });

    // Desconexão
    socket.on('disconnect', () => {
        console.log('Jogador desconectado:', socket.id);
        
        // Remover da fila de espera
        const waitingIndex = waitingPlayers.findIndex(p =>```
