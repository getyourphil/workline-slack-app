require('dotenv').config();
const { App } = require('@slack/bolt');

console.log('🚀 Starting simple Workline app...');

// Check if we have the required tokens
if (!process.env.SLACK_BOT_TOKEN) {
    console.error('❌ SLACK_BOT_TOKEN is missing from .env file');
    process.exit(1);
}

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

// Simple test command
app.command('/workline', async ({ command, ack, respond }) => {
    await ack();
    
    const query = command.text.trim();
    
    if (!query) {
        await respond({
            text: "👋 Hello! I'm the Workline search bot. Try typing `/workline test` to see if I'm working!"
        });
        return;
    }
    
    if (query.toLowerCase() === 'test') {
        await respond({
            text: "🎉 Success! The Workline bot is working. Next, we'll add real search functionality."
        });
        return;
    }
    
    await respond({
        text: `🔍 You searched for: "${query}"\n(Real search functionality coming soon!)`
    });
});

// Start the app
(async () => {
    try {
        await app.start();
        console.log('⚡️ Workline Slack app is running!');
        console.log('💡 Try typing "/workline test" in Slack');
    } catch (error) {
        console.error('Failed to start app:', error);
    }
})();