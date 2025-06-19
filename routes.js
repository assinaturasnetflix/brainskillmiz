// routes.js

const express = require('express');
const router = express.Router();
const controllers = require('./controllers');
const { protect, authorize } = require('./controllers'); // Assumindo que protect e authorize estão em controllers.js

// --- Rotas de Autenticação e Usuário Geral ---
router.post('/register', controllers.register);
router.post('/login', controllers.login);
router.post('/forgot-password', controllers.forgotPassword);
router.post('/reset-password', controllers.resetPassword);

// Rotas protegidas (requerem token JWT válido)
router.use(protect); // Todas as rotas abaixo desta linha exigirão autenticação

router.get('/profile', controllers.getProfile);
router.put('/profile', controllers.updateProfile);
router.post('/upload-avatar', controllers.uploadAvatar);
router.get('/ranking', controllers.getRanking); // Para ver perfis de outros jogadores

// --- Rotas de Saldo e Transações ---
router.get('/balance', controllers.getBalance);
router.post('/deposit-request', controllers.requestDeposit);
router.post('/withdraw-request', controllers.requestWithdrawal);
router.get('/transactions/history', controllers.getTransactionHistory); // Para ver histórico de depósitos/levantamentos

// --- Rotas de Jogo e Lobby ---
router.get('/lobby', controllers.getOpenLobbyRooms);
router.post('/lobby/create', controllers.createLobbyRoom);
router.post('/lobby/:roomId/join', controllers.joinLobbyRoom); // Inicia uma partida após aceitar a aposta
router.get('/games/history', controllers.getGameHistory); // Histórico de partidas jogadas pelo usuário
router.get('/game/:gameId/result', controllers.getGameResult); // Resultado de uma partida específica

// --- Rotas Administrativas (requerem role de 'admin') ---
router.use(authorize('admin')); // Todas as rotas abaixo desta linha exigirão role de admin

router.get('/admin/users', controllers.adminGetAllUsers);
router.put('/admin/users/:userId/block', controllers.adminBlockUser);
router.put('/admin/users/:userId/unblock', controllers.adminUnblockUser);
router.put('/admin/users/:userId/balance', controllers.adminUpdateUserBalance); // Adicionar/remover saldo manualmente

router.get('/admin/deposits', controllers.adminGetDepositRequests);
router.put('/admin/deposits/:depositId/approve', controllers.adminApproveDeposit);
router.put('/admin/deposits/:depositId/reject', controllers.adminRejectDeposit);

router.get('/admin/withdrawals', controllers.adminGetWithdrawalRequests);
router.put('/admin/withdrawals/:withdrawalId/approve', controllers.adminApproveWithdrawal);
router.put('/admin/withdrawals/:withdrawalId/reject', controllers.adminRejectWithdrawal);

router.get('/admin/games', controllers.adminGetAllGames); // Ver partidas ao vivo ou encerradas
router.get('/admin/stats', controllers.adminGetPlatformStats); // Total depositado, levantado, ganho, comissão

router.post('/admin/settings', controllers.adminUpdateSetting); // Definir limites, regras, textos
router.get('/admin/settings', controllers.adminGetSettings);

module.exports = router;

/*
Para executar este arquivo localmente:

Este arquivo é um módulo que define as rotas da API e será importado e usado por `server.js`.
Não há necessidade de executá-lo diretamente.
Certifique-se de que `controllers.js` esteja no mesmo nível de diretório para que as importações funcionem corretamente.
*/