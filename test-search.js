// Simple test to make sure our search functionality works
const axios = require('axios');
const cheerio = require('cheerio');

async function testWorklineSearch() {
    console.log('🔍 Testing Workline search...');
    
    try {
        // Test 1: Can we reach the Workline site?
        const response = await axios.get('https://www.flexos.work/the-workline/', {
            timeout: 10000,
            headers: {
                'User-Agent': 'WorklineSlackBot/1.0 (Test)'
            }
        });
        
        console.log('✅ Successfully connected to Workline site');
        console.log(`📄 Page title: ${response.data.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'Not found'}`);
        
        // Test 2: Can we parse HTML?
        const $ = cheerio.load(response.data);
        const linkCount = $('a').length;
        console.log(`🔗 Found ${linkCount} links on the page`);
        
        // Test 3: Look for article links
        const articleLinks = [];
        $('a[href*="workline"], a[href*="/the-workline/"]').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && text && href !== 'https://www.flexos.work/the-workline/') {
                articleLinks.push({ href, text: text.substring(0, 50) });
            }
        });
        
        console.log(`📚 Found ${articleLinks.length} potential article links:`);
        articleLinks.slice(0, 5).forEach((link, i) => {
            console.log(`   ${i+1}. ${link.text}...`);
        });
        
        console.log('\n🎉 Basic search test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

// Run the test
testWorklineSearch();