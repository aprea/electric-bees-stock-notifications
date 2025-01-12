import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync } from 'fs';
import { Octokit } from '@octokit/rest';
import { createHash } from 'crypto';

puppeteer.use(StealthPlugin());

const STOCK_AVAILABILITY_URLS = process.env.STOCK_AVAILABILITY_URLS?.split(',') || [];
const PREFERRED_STORE_IDS = process.env.PREFERRED_STORE_IDS?.split(',').map(Number) || [];
const UPDATE_HASH = process.env.UPDATE_HASH || '';
const GH_TOKEN = process.env.GH_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';

class StockAvailabilityFinder {
    constructor() {
        this.octokit = new Octokit({ auth: GH_TOKEN });
        this.owner = GITHUB_REPOSITORY.split('/')[0];
        this.repo = GITHUB_REPOSITORY.split('/')[1];
    }

    async updateHashSecret(hash) {
        try {
            await this.octokit.actions.createRepoVariable({
              owner: this.owner,
              repo: this.repo,
              name: 'UPDATE_HASH',
              value: hash,
            });
            console.log('Successfully updated hash');
          } catch (error) {
            console.error('Error updating hash:', error.message);
            throw error;
          }
    }

    async findAndNotifyStockAvailability() {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const page = await browser.newPage();
            
            // Block unnecessary resources
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                if (['document'].includes(request.resourceType())) {
                    request.continue();
                } else {
                    request.abort();
                }
            });

            const stockData = STOCK_AVAILABILITY_URLS.map(() => ({
                productTitle: 'Unknown',
                storeData: []
            }));

            let i = 0;
            let someHaveStock = false;
            
            for (const url of STOCK_AVAILABILITY_URLS) {
                try {
                    const response = await page.goto(url, { 
                        waitUntil: 'domcontentloaded',
                        timeout: 10000
                    });
                    
                    // Get the page source
                    const pageContent = await response.text();

                    const itemNameElement = await page.$('.store-product-title');
                    if (itemNameElement) {
                        stockData[i].productTitle = await page.evaluate(element => element.textContent.trim(), itemNameElement);
                    }
                    
                    // Extract the JSON array from window.storeFinder call
                    const match = pageContent.match(/window\.storeFinder\(\s*(\[[\s\S]*?\])\s*,\s*'AU'/);
                    
                    if (match?.[1]) {
                        // Parse the JSON array
                        try {
                            const storeData = JSON.parse(match[1]);

                            for (const store of storeData) {
                                if (PREFERRED_STORE_IDS.includes(store.Id)) {
                                    stockData[i].storeData.push({
                                        id: store.Id,
                                        name: store.Name,
                                        itemInStock: Math.random() > 0.5 ? true : store.SearchedProductIsInStock,
                                    }); 
                                }

                                if (store.SearchedProductIsInStock) {
                                    someHaveStock = true;
                                }
                            }
                        } catch (parseError) {
                            console.error(`Error parsing JSON from ${url}:`, parseError);
                        }
                    }
                } catch (error) {
                    console.error(`Error fetching ${url}:`, error.message);
                }
                ++i;
            }

            if (!someHaveStock) {
                process.exit(78);
            }
            
            const hash = createHash('sha256').update(JSON.stringify(stockData)).digest('hex');

            if (UPDATE_HASH === hash) {
                process.exit(78);
            }

            await this.updateHashSecret(hash);

            return stockData;
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
}

const stockAvailabilityFinderInstance = new StockAvailabilityFinder();

stockAvailabilityFinderInstance.findAndNotifyStockAvailability()
    .then((result) => {
        // Write result to a file for GitHub Actions to read
        writeFileSync('results.json', JSON.stringify(result));
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });