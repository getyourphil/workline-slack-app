require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');
const cheerio = require('cheerio');

// Add port configuration for deployment
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting enhanced Workline search app with Google Search...');

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

// Cache for articles (simple in-memory cache)
const articleCache = new Map();
let lastCacheTime = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Google Custom Search configuration
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const WORKLINE_SITE = 'www.flexos.work/the-workline/';

// Enhanced article scraper
async function scrapeArticle(url) {
    try {
        console.log(`📄 Scraping: ${url}`);
        
        const response = await axios.get(url, {
            timeout: 15000,
            headers: { 
                'User-Agent': 'WorklineSlackBot/1.0 (Workplace Research Assistant)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        const $ = cheerio.load(response.data);
        
        // Enhanced title extraction
        const title = $('h1').first().text().trim() || 
                     $('title').text().replace(' | FlexOS', '').replace(' | The Workline', '').trim() ||
                     $('[class*="title"]').first().text().trim();
        
        // Enhanced summary extraction
        let summary = $('meta[name="description"]').attr('content') ||
                     $('meta[property="og:description"]').attr('content') ||
                     $('.excerpt, .summary, .intro').first().text().trim();
        
        // If no meta description, extract from content
        if (!summary || summary.length < 50) {
            const contentSelectors = [
                'article p:first-of-type',
                '.content p:first-of-type', 
                '.post-content p:first-of-type',
                '.entry-content p:first-of-type',
                'main p:first-of-type',
                'p'
            ];
            
            for (const selector of contentSelectors) {
                const firstPara = $(selector).first().text().trim();
                if (firstPara && firstPara.length > 30) {
                    summary = firstPara.substring(0, 250);
                    break;
                }
            }
        }
        
        // Extract main content for searching
        let content = '';
        const contentSelectors = [
            'article',
            '.content, .post-content, .entry-content',
            'main',
            '.post, .article'
        ];
        
        for (const selector of contentSelectors) {
            const element = $(selector);
            if (element.length > 0) {
                content = element.text().trim();
                break;
            }
        }
        
        // Fallback to body if no specific content found
        if (!content || content.length < 100) {
            content = $('body').text().trim();
        }
        
        // Clean up content
        content = content.replace(/\s+/g, ' ').substring(0, 3000);
        
        // Extract topics/tags
        const topics = [];
        $('[class*="tag"], [class*="category"], [rel="tag"], .hashtag').each((i, el) => {
            const tag = $(el).text().trim().toLowerCase().replace('#', '');
            if (tag && tag.length > 2 && !topics.includes(tag)) {
                topics.push(tag);
            }
        });
        
        // Extract publish date
        const publishDate = $('time[datetime]').attr('datetime') ||
                           $('meta[property="article:published_time"]').attr('content') ||
                           $('.date, .published, .post-date').first().text().trim();
        
        const result = {
            url,
            title: title.substring(0, 150),
            summary: summary ? summary.substring(0, 300) + (summary.length > 300 ? '...' : '') : '',
            content,
            topics: topics.slice(0, 5),
            publishDate,
            scrapedAt: new Date().toISOString()
        };
        
        console.log(`✅ Scraped: ${result.title}`);
        return result;
        
    } catch (error) {
        console.error(`❌ Error scraping ${url}:`, error.message);
        return { url, title: 'Article', summary: 'Could not load summary', content: '', topics: [] };
    }
}

// Google Custom Search function
async function searchWithGoogle(query) {
    if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
        console.log('⚠️ Google Search not configured, using local cache only');
        return [];
    }
    
    try {
        console.log(`🔍 Searching Google for: "${query}"`);
        
        const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=10`;
        
        const response = await axios.get(searchUrl, { timeout: 10000 });
        
        if (!response.data.items) {
            console.log('📭 No Google results found');
            return [];
        }
        
        console.log(`📊 Google found ${response.data.items.length} results`);
        
        // Process Google results
        const results = await Promise.all(
            response.data.items.slice(0, 5).map(async (item) => {
                // Check if we have this article cached
                let articleData = articleCache.get(item.link);
                
                if (!articleData) {
                    // Scrape it fresh
                    articleData = await scrapeArticle(item.link);
                    if (articleData && articleData.title !== 'Article') {
                        articleCache.set(item.link, articleData);
                    }
                }
                
                return {
                    url: item.link,
                    title: articleData?.title || item.title,
                    summary: articleData?.summary || item.snippet,
                    topics: articleData?.topics || [],
                    publishDate: articleData?.publishDate,
                    source: 'google',
                    score: 10 // Google results get high relevance score
                };
            })
        );
        
        return results.filter(result => result !== null);
        
    } catch (error) {
        console.error('❌ Google Search error:', error.message);
        return [];
    }
}

// Local cache search function
async function searchCachedArticles(query) {
    // Refresh cache if needed
    if (!lastCacheTime || Date.now() - lastCacheTime > CACHE_DURATION) {
        await refreshArticleCache();
    }
    
    const queryTerms = query.toLowerCase().split(' ').filter(term => term.length > 2);
    const results = [];
    
    for (const [url, article] of articleCache.entries()) {
        let score = 0;
        const searchableText = `${article.title} ${article.summary} ${article.content}`.toLowerCase();
        
        // Scoring system
        queryTerms.forEach(term => {
            // Title matches are most important
            if (article.title.toLowerCase().includes(term)) {
                score += 5;
            }
            // Summary matches are important
            if (article.summary.toLowerCase().includes(term)) {
                score += 3;
            }
            // Topic matches are good
            if (article.topics.some(topic => topic.includes(term))) {
                score += 2;
            }
            // Content matches count
            const contentMatches = (searchableText.match(new RegExp(term, 'g')) || []).length;
            score += Math.min(contentMatches, 3); // Cap content score
        });
        
        if (score > 0) {
            results.push({ ...article, score, source: 'cache' });
        }
    }
    
    return results.sort((a, b) => b.score - a.score);
}

// Main search function that combines Google + cache
async function searchWorklineArticles(query) {
    console.log(`🔍 Searching for: "${query}"`);
    
    // Always try Google search first (more comprehensive)
    const googleResults = await searchWithGoogle(query);
    
    // Also search local cache
    const cacheResults = await searchCachedArticles(query);
    
    // Combine and deduplicate results
    const allResults = [...googleResults];
    
    // Add cache results that aren't already in Google results
    cacheResults.forEach(cacheResult => {
        const alreadyExists = allResults.some(result => result.url === cacheResult.url);
        if (!alreadyExists) {
            allResults.push(cacheResult);
        }
    });
    
    // Sort by score and return top 5
    return allResults
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
}

// Discover articles and build cache
async function refreshArticleCache() {
    try {
        console.log('🔄 Refreshing article cache...');
        
        const response = await axios.get('https://www.flexos.work/the-workline/', {
            timeout: 15000,
            headers: { 'User-Agent': 'WorklineSlackBot/1.0' }
        });
        
        const $ = cheerio.load(response.data);
        const articleUrls = new Set();
        
        // Multiple selectors to find article links
        const linkSelectors = [
            'a[href*="/the-workline/"]',
            'a[href*="workline"]',
            '.post-link, .article-link',
            'article a, .post a',
            'h1 a, h2 a, h3 a'
        ];
        
        linkSelectors.forEach(selector => {
            $(selector).each((i, el) => {
                let href = $(el).attr('href');
                if (href) {
                    // Convert relative URLs to absolute
                    if (href.startsWith('/')) {
                        href = `https://www.flexos.work${href}`;
                    }
                    
                    // Only include Workline articles, exclude the main index
                    if (href.includes('workline') && 
                        href !== 'https://www.flexos.work/the-workline/' &&
                        !href.includes('#') && 
                        !href.includes('mailto:')) {
                        articleUrls.add(href);
                    }
                }
            });
        });
        
        console.log(`🔍 Found ${articleUrls.size} unique articles to cache`);
        
        // Scrape articles in small batches to be polite
        const urls = Array.from(articleUrls);
        const batchSize = 2;
        
        for (let i = 0; i < Math.min(urls.length, 20); i += batchSize) { // Limit to 20 articles
            const batch = urls.slice(i, i + batchSize);
            const promises = batch.map(url => scrapeArticle(url));
            const results = await Promise.all(promises);
            
            results.forEach(article => {
                if (article && article.title !== 'Article') {
                    articleCache.set(article.url, article);
                }
            });
            
            // Small delay between batches
            if (i + batchSize < urls.length) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        lastCacheTime = Date.now();
        console.log(`✅ Cached ${articleCache.size} articles`);
        
    } catch (error) {
        console.error('❌ Error refreshing cache:', error.message);
    }
}

// Format results with Slack blocks for clean appearance
function formatSearchResults(query, results) {
    const blocks = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `🎯 *Found ${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"*`
            }
        },
        { type: "divider" }
    ];

    results.forEach((result, index) => {
        // Add search source indicator
        const sourceEmoji = result.source === 'google' ? '🌐' : '💾';
        
        // Main article block
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `${sourceEmoji} *<${result.url}|${result.title}>*\n${result.summary}`
            },
            accessory: {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "📖 Read Article"
                },
                url: result.url,
                action_id: `read_${index}`
            }
        });
        
        // Add topics and metadata if available
        const metadata = [];
        if (result.topics && result.topics.length > 0) {
            metadata.push(`🏷️ ${result.topics.slice(0, 3).join(', ')}`);
        }
        if (result.publishDate) {
            try {
                const date = new Date(result.publishDate).toLocaleDateString();
                metadata.push(`📅 ${date}`);
            } catch (e) {
                // Ignore date parsing errors
            }
        }
        if (result.source) {
            metadata.push(`🔍 ${result.source === 'google' ? 'Google Search' : 'Local Cache'}`);
        }
        
        if (metadata.length > 0) {
            blocks.push({
                type: "context",
                elements: [
                    {
                        type: "mrkdwn",
                        text: metadata.join(' • ')
                    }
                ]
            });
        }
        
        // Add divider between results (except for last one)
        if (index < results.length - 1) {
            blocks.push({ type: "divider" });
        }
    });

    // Footer with tips
    blocks.push(
        { type: "divider" },
        {
            type: "context",
            elements: [
                {
                    type: "mrkdwn",
                    text: "💡 *Tip:* 🌐 = Google Search results, 💾 = Local cache results"
                }
            ]
        }
    );

    return { blocks };
}

// Main command handler
app.command('/workline', async ({ command, ack, respond }) => {
    await ack();
    
    const query = command.text.trim();
    
    if (!query) {
        const hasGoogleSearch = GOOGLE_API_KEY && GOOGLE_CSE_ID;
        
        await respond({
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "🔍 *Welcome to Workline Search*\n\nI can help you find Phil Kirschner's insights on workplace transformation, hybrid work, and organizational change."
                    }
                },
                { type: "divider" },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "*How to search:*\n• `/workline change management` - Find change insights\n• `/workline hybrid work` - Discover hybrid strategies\n• `/workline employee experience` - Explore EX topics\n• `/workline IKEA` - Find specific terms within articles"
                    }
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Search powered by:* ${hasGoogleSearch ? '🌐 Google Custom Search + 💾 Local Cache' : '💾 Local Cache Only'}\n*Popular topics:* change management, hybrid work, employee experience, workplace metrics, leadership, innovation`
                    }
                }
            ]
        });
        return;
    }
    
    // Show "searching" indicator
    await respond({
        text: `🔍 Searching for "${query}"...`,
        response_type: "ephemeral"
    });
    
    try {
        const results = await searchWorklineArticles(query);
        
        if (results.length === 0) {
            await respond({
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `🤷‍♂️ No articles found for *"${query}"*`
                        }
                    },
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: "*Try searching for:*\n• change management\n• hybrid work\n• employee experience\n• workplace metrics\n• innovation\n• leadership"
                        }
                    }
                ],
                replace_original: true
            });
            return;
        }
        
        await respond({
            ...formatSearchResults(query, results),
            replace_original: true
        });
        
    } catch (error) {
        console.error('❌ Search error:', error);
        await respond({
            text: "Sorry, I encountered an error while searching. Please try again in a moment.",
            replace_original: true
        });
    }
});

// Handle button clicks (for analytics or future features)
app.action(/^read_\d+$/, async ({ ack }) => {
    await ack();
    // Button click acknowledged - could add analytics here
});

// Handle direct messages to the bot
app.message(async ({ message, say }) => {
    // Only respond to direct messages (not channel mentions)
    if (message.channel_type !== 'im') {
        return;
    }
    
    const query = message.text.trim();
    
    // Ignore empty messages or common greetings
    if (!query || query.length < 3) {
        await say("👋 Hi! I can help you search Workline articles. Try asking me something like:\n• \"change management\"\n• \"hybrid work strategies\"\n• \"employee experience tips\"");
        return;
    }
    
    // Common greetings - respond helpfully
    if (/^(hi|hello|hey|help)$/i.test(query)) {
        await say("👋 Hello! I can search Phil Kirschner's Workline articles for you. Just type what you're looking for:\n• \"change management\"\n• \"IKEA furniture example\"\n• \"workplace metrics\"");
        return;
    }
    
    try {
        // Show typing indicator
        await say(`🔍 Searching for "${query}"...`);
        
        // Use your existing search function
        const results = await searchWorklineArticles(query);
        
        if (results.length === 0) {
            await say(`🤷‍♂️ No articles found for "${query}". Try terms like: change management, hybrid work, employee experience, or workplace innovation.`);
            return;
        }
        
        // Format results for direct message (same as slash command)
        await say(formatSearchResults(query, results));
        
    } catch (error) {
        console.error('❌ DM search error:', error);
        await say("Sorry, I encountered an error while searching. Please try again in a moment.");
    }
});

// Start the app with initial cache load
(async () => {
    try {
        console.log('🚀 Starting enhanced Workline app...');
        
        // Check Google Search configuration
        if (GOOGLE_API_KEY && GOOGLE_CSE_ID) {
            console.log('✅ Google Custom Search configured');
        } else {
            console.log('⚠️ Google Custom Search not configured - using local cache only');
        }
        
        // Pre-load cache (but don't wait too long in production)
        if (process.env.NODE_ENV !== 'production') {
            console.log('📚 Pre-loading article cache...');
            await refreshArticleCache();
        } else {
            // In production, load cache in background
            console.log('📚 Loading cache in background...');
            refreshArticleCache().catch(console.error);
        }
        
        await app.start(PORT);
        console.log(`⚡️ Enhanced Workline search app is running on port ${PORT}!`);
        console.log(`📖 Ready to search articles`);
        
    } catch (error) {
        console.error('❌ Failed to start app:', error);
    }
})();