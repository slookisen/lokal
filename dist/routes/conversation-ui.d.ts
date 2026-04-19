/**
 * Conversation UI Routes — Human-readable A2A conversation views
 *
 * Renders agent-to-agent conversations as WhatsApp-like chat dialogs.
 * This makes the A2A protocol tangible for humans — you can see
 * what agents are actually saying to each other.
 *
 * Routes:
 *   GET /samtaler           → List of recent conversations
 *   GET /samtale/:id        → Single conversation as chat dialog
 *
 * Real-time: The chat view connects to /api/live SSE for live
 * message updates — new bubbles appear without page refresh.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=conversation-ui.d.ts.map