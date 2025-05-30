require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');
const cheerio = require('cheerio');

console.log('🚀 Starting Workline search app...');

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

// Simple article scraper
async function scrapeArticle(url) {
    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: { 'User-Agent': 'WorklineSlackBot/1.0' }
        });
        
        const $ = cheerio.load(response.data);
        const title = $('h1').first().text().trim() || $('title').text().trim();
        const summary = $('meta[name="description"]').attr('content') || 
                       $('p').first().text().trim().substring(0, 200);
        
        return { url, title, summary: summary + '...' };
    } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        return null;
    }
}

// Discover articles from main page
async function findWorklineArticles(query) {
    try {
        console.log('🔍 Searching for articles...');
        
        // Get the main Workline page
        const response = await axios.get('https://www.flexos.work/the-workline/', {
            timeout: 10000,
            headers: { 'User-Agent': 'WorklineSlackBot/1.0' }
        });
        
        const $ = cheerio.load(response.data);
        const articleLinks = [];
        
        // Find article links
        $('a[href*="/the-workline/"], a[href*="workline"]').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && text && href !== 'https://www.flexos.work/the-workline/' && href.includes('workline')) {
                let fullUrl = href.startsWith('http') ? href : `https://www.flexos.work${href}`;
                articleLinks.push({ url: fullUrl, title: text });
            }
        });
        
        console.log(`📚 Found ${articleLinks.length} articles`);
        
        // Filter by query if provided
        if (query && query !== 'latest') {
            const queryTerms = query.toLowerCase().split(' ');
            return articleLinks.filter(article => 
                queryTerms.some(term => 
                    article.title.toLowerCase().includes(term)
                )
            ).slice(0, 3);
        }
        
        return articleLinks.slice(0, 3); // Return first 3
        
    } catch (error) {
        console.error('Search error:', error.message);
        return [];
    }
}

// Main command handler
app.command('/workline', async ({ command, ack, respond }) => {
    await ack();
    
    const query = command.text.trim();
    
    if (!query) {
        await respond({
            text: "🔍 *Search The Workline Articles*\n\nTry:\n• `/workline change management`\n• `/workline hybrid work`\n• `/workline latest`"
        });
        return;
    }
    
    // Show searching message
    await respond({
        text: `🔍 Searching for "${query}"...`,
        response_type: "ephemeral"
    });
    
    try {
        const articles = await findWorklineArticles(query);
        
        if (articles.length === 0) {
            await respond({
                text: `No articles found for "${query}". Try: change management, hybrid work, or employee experience.`,
                replace_original: true
            });
            return;
        }
        
        // Format results
        let response = `🎯 *Found ${articles.length} article${articles.length !== 1 ? 's' : ''} for "${query}":*\n\n`;
        
        for (let i = 0; i < articles.length; i++) {
            const article = articles[i];
            response += `${i + 1}. *<${article.url}|${article.title}>*\n`;
            
            // Try to get summary
            const details = await scrapeArticle(article.url);
            if (details && details.summary) {
                response += `   ${details.summary}\n`;
            }
            response += '\n';
        }
        
        await respond({
            text: response,
            replace_original: true
        });
        
    } catch (error) {
        console.error('Command error:', error);
        await respond({
            text: "Sorry, I encountered an error while searching. Please try again.",
            replace_original: true
        });
    }
});

// Start the app
(async () => {
    try {
        await app.start();
        console.log('⚡️ Workline search app is running!');
        console.log('💡 Try: /workline latest or /workline change management');
    } catch (error) {
        console.error('Failed to start app:', error);
    }
})();