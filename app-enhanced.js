require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');
const cheerio = require('cheerio');

// Add port configuration for deployment
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting enhanced Workline search app...');

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

// Smart search function
async function searchWorklineArticles(query) {
    // Refresh cache if needed
    if (!lastCacheTime || Date.now() - lastCacheTime > CACHE_DURATION) {
        await refreshArticleCache();
    }
    
    if (articleCache.size === 0) {
        console.log('⚠️ No articles in cache, attempting fresh search...');
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
            results.push({ ...article, score });
        }
    }
    
    return results
        .sort((a, b) => b.score - a.score)
        .slice(0, 5); // Return top 5 results
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
        // Main article block
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*<${result.url}|${result.title}>*\n${result.summary}`
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
                    text: "💡 *Tip:* Try specific terms like 'change management', 'hybrid work', or 'employee experience' for better results"
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
                        text: "*How to search:*\n• `/workline change management` - Find change insights\n• `/workline hybrid work` - Discover hybrid strategies\n• `/workline employee experience` - Explore EX topics\n• `/workline latest` - See recent articles"
                    }
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "*Popular topics:* change management, hybrid work, employee experience, workplace metrics, leadership, innovation, remote work"
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

// Start the app with initial cache load
(async () => {
    try {
        console.log('🚀 Starting enhanced Workline app...');
        
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
        console.log(`📖 Ready to search ${articleCache.size} cached articles`);
        console.log('💡 Try: /workline change management');
        
    } catch (error) {
        console.error('❌ Failed to start app:', error);
    }
})();