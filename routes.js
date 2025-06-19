// routes.js
// Este arquivo define todas as rotas da API REST para o projeto BrainSkill.

const express = require('express');
const {
    registerUser,
    loginUser,
    forgotPassword,
    resetPassword,
    getUserProfile,
    updateUserProfile,
    uploadAvatar,
    requestDeposit,
    requestWithdrawal,
    getGameHistory,
    getRanking,
    createLobby,
    joinLobby,
    cancelLobby, // Adicionado para permitir o criador cancelar o lobby
    getLobbies,
    // Admin functions
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
    getPlatformSettings
} = require('./controllers');
const { protect, authorize } = require('./controllers'); // Middleware de autenticação e autorização
// Nota: O middleware 'auth.js' não foi solicitado como um arquivo separado,
// mas é crucial para a segurança. Vou assumir que será parte de controllers.js
// ou que o prompt implica que ele pode ser um módulo auxiliar.
// Para aderir estritamente ao prompt de 4 arquivos, vou colocá-lo dentro de controllers.js.

module.exports = function(app) {
    // --- Rotas de Autenticação e Usuário ---
    app.post('/api/auth/register', registerUser);
    app.post('/api/auth/login', loginUser);
    app.post('/api/auth/forgot-password', forgotPassword);
    app.post('/api/auth/reset-password', resetPassword);

    // --- Rotas de Perfil de Usuário (Protegidas) ---
    app.get('/api/users/profile', protect, getUserProfile);
    app.put('/api/users/profile', protect, updateUserProfile);
    app.post('/api/users/profile/avatar', protect, uploadAvatar); // Rota para upload de avatar
    app.get('/api/users/ranking', getRanking); // Página de ranking para ver perfis de outros jogadores

    // --- Rotas de Saldo (Protegidas) ---
    app.post('/api/transactions/deposit', protect, requestDeposit);
    app.post('/api/transactions/withdrawal', protect, requestWithdrawal);
    app.get('/api/users/balance', protect, getUserProfile); // Reusa getUserProfile para obter saldo

    // --- Rotas de Lobby e Jogo (Protegidas) ---
    app.post('/api/lobby/create', protect, createLobby);
    app.post('/api/lobby/:lobbyId/join', protect, joinLobby);
    app.delete('/api/lobby/:lobbyId', protect, cancelLobby); // Rota para cancelar lobby
    app.get('/api/lobby', getLobbies); // Rota pública para ver lobbies ativos

    // --- Rotas de Histórico de Jogos (Protegidas) ---
    app.get('/api/games/history', protect, getGameHistory);
    // Nota: Os resultados da partida são gerenciados via WebSocket e atualizados no histórico.

    // --- Rotas de Administração (Protegidas e Autorizadas para Admin) ---
    app.post('/api/admin/login', adminLogin);
    app.get('/api/admin/users', protect, authorize(['admin']), getAllUsers);
    app.put('/api/admin/users/:userId/block', protect, authorize(['admin']), blockUser);
    app.put('/api/admin/users/:userId/unblock', protect, authorize(['admin']), unblockUser);

    app.get('/api/admin/deposits/pending', protect, authorize(['admin']), getPendingDeposits);
    app.put('/api/admin/deposits/:depositId/approve', protect, authorize(['admin']), approveDeposit);
    app.put('/api/admin/deposits/:depositId/reject', protect, authorize(['admin']), rejectDeposit);

    app.get('/api/admin/withdrawals/pending', protect, authorize(['admin']), getPendingWithdrawals);
    app.put('/api/admin/withdrawals/:withdrawalId/approve', protect, authorize(['admin']), approveWithdrawal);
    app.put('/api/admin/withdrawals/:withdrawalId/reject', protect, authorize(['admin']), rejectWithdrawal);

    app.post('/api/admin/users/:userId/add-balance', protect, authorize(['admin']), addBalance);
    app.post('/api/admin/users/:userId/remove-balance', protect, authorize(['admin']), removeBalance);

    app.get('/api/admin/games/live', protect, authorize(['admin']), getLiveGames);
    app.get('/api/admin/games/completed', protect, authorize(['admin']), getCompletedGames);

    app.get('/api/admin/summary', protect, authorize(['admin']), getPlatformFinancialSummary);

    app.get('/api/admin/settings', protect, authorize(['admin']), getPlatformSettings);
    app.put('/api/admin/settings', protect, authorize(['admin']), updatePlatformSettings);

    // Nota: A lógica de validação de jogadas e atualização do estado do jogo
    // ocorrerá primariamente via Socket.io no controllers.js, não via rotas REST diretas.
};

// Instruções básicas para rodar localmente:
// 1. Este arquivo será importado em server.js.
// 2. Ele define as rotas da API, direcionando as requisições para as funções controladoras apropriadas.
// 3. Os middlewares 'protect' e 'authorize' são usados para segurança e controle de acesso.
//    Eles serão definidos dentro do arquivo controllers.js para cumprir a restrição de 4 arquivos.