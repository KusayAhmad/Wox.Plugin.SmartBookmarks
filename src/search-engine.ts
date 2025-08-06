import { Bookmark, SearchResult } from "./interfaces";
import { Logger } from "./logger";
import { CacheManager } from "./cache-manager";

export class SearchEngine {
  private cacheManager: CacheManager;
  
  constructor(cacheManager?: CacheManager) {
    this.cacheManager = cacheManager || new CacheManager();
  }

  calculateScore(bookmark: Bookmark, searchTerm: string): number {
    if (!searchTerm || searchTerm.trim() === '') return 50;
    
    const term = searchTerm.toLowerCase().trim();
    const title = bookmark.title.toLowerCase();
    const url = bookmark.url.toLowerCase();
    const description = (bookmark.description || '').toLowerCase();
    const tags = (bookmark.tags || '').toLowerCase();
    const source = (bookmark.source || '').toLowerCase();
    
    let score = 0;

    // 🔥 Special bonus for browser-specific searches
    const browserSearchBonus = this.getBrowserSearchBonus(term, source);
    score += browserSearchBonus;

    // 🎯 Exact title match (highest score)
    if (title === term) score += 1000;
    else if (title.includes(term)) {
      // Match at beginning of title
      if (title.startsWith(term)) score += 800;
      // Whole word match
      else if (title.includes(` ${term} `) || title.includes(` ${term}`)) score += 600;
      // Partial match
      else score += 400;
    }

    // 🔗 URL matching
    if (url.includes(term)) {
      // Domain matching (high priority)
      const domain = url.replace(/^https?:\/\//, '').split('/')[0];
      if (domain.includes(term)) score += 300;
      else score += 150;
    }

    // 📝 Description matching
    if (description.includes(term)) score += 200;

    // 🏷️ Tags matching
    if (tags.includes(term)) score += 250;

    // 🌐 Browser source matching
    if (source.includes(term)) score += 100;

    // 📊 Additional factors for smart sorting
    
    // Visit frequency
    const visitCount = bookmark.visitCount || 0;
    if (visitCount > 0) {
      score += Math.min(visitCount * 2, 100); // Max 100 points for visits
    }

    // Recency of use
    if (bookmark.lastUsed && bookmark.lastUsed !== "0" && bookmark.lastUsed !== "Never") {
      try {
        const lastUsedDate = new Date(bookmark.lastUsed);
        const daysSinceUsed = (Date.now() - lastUsedDate.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceUsed < 1) score += 80;        // Used today
        else if (daysSinceUsed < 7) score += 60;   // Used this week
        else if (daysSinceUsed < 30) score += 40;  // Used this month
        else if (daysSinceUsed < 90) score += 20;  // Used within 3 months
      } catch (e) {
        // Ignore date parsing errors
      }
    }

    // Title length (shorter titles are usually better)
    if (title.length < 30) score += 10;
    else if (title.length > 100) score -= 10;

    // Site type (popular sites)
    const popularSites = ['github', 'stackoverflow', 'google', 'youtube', 'facebook', 'twitter', 'linkedin'];
    for (const site of popularSites) {
      if (url.includes(site)) {
        score += 30;
        break;
      }
    }

    // 🚫 Reduce priority for local bookmarks when searching for specific browser
    if (!bookmark.source && this.isSearchingForSpecificBrowser(term)) {
      score = Math.max(score - 500, 1); // Significant score reduction
    }

    return Math.max(score, 1); // ضمان وجود نقطة واحدة على الأقل
  }

  private getBrowserSearchBonus(searchTerm: string, bookmarkSource: string): number {
    const term = searchTerm.toLowerCase();
    const source = bookmarkSource.toLowerCase();
    
    // If search includes browser name and bookmark is from same browser
    if ((term.includes('chrome') && source === 'chrome') ||
        (term.includes('edge') && source === 'edge') ||
        (term.includes('brave') && source === 'brave') ||
        (term.includes('firefox') && source === 'firefox')) {
      return 2000; // Very high bonus
    }
    
    return 0;
  }

  private isSearchingForSpecificBrowser(searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    return term.includes('chrome') || term.includes('edge') || term.includes('brave') || term.includes('firefox');
  }

  smartSearch(bookmarks: Bookmark[], searchTerm: string, maxResults: number): SearchResult[] {
    // Check cache first for non-empty search terms
    if (searchTerm && searchTerm.trim() !== '') {
      const cachedResults = this.cacheManager.getCachedSearchResults(searchTerm);
      if (cachedResults) {
        Logger.log(`Search cache hit for term: "${searchTerm}"`);
        return cachedResults.slice(0, maxResults);
      }
    }

    if (!searchTerm || searchTerm.trim() === '') {
      // If no search term, show most recently used
      return bookmarks
        .sort((a, b) => {
          const aLastUsed = a.lastUsed && a.lastUsed !== "0" && a.lastUsed !== "Never" ? new Date(a.lastUsed).getTime() : 0;
          const bLastUsed = b.lastUsed && b.lastUsed !== "0" && b.lastUsed !== "Never" ? new Date(b.lastUsed).getTime() : 0;
          return bLastUsed - aLastUsed;
        })
        .slice(0, maxResults)
        .map(bookmark => ({ bookmark, score: 50 })); // Default score for no search
    }

    const term = searchTerm.toLowerCase().trim();

    // Apply search and sorting
    const results = bookmarks
      .map(bookmark => ({
        bookmark,
        score: this.calculateScore(bookmark, term)
      }))
      .filter(item => item.score > 0) // Only results with positive scores
      .sort((a, b) => b.score - a.score) // Sort descending by score
      .slice(0, maxResults);

    // Cache the results for future use
    if (searchTerm && searchTerm.trim() !== '') {
      this.cacheManager.cacheSearchResults(searchTerm, results);
      Logger.log(`Cached ${results.length} search results for term: "${searchTerm}"`);
    }

    return results;
  }

  searchInFolder(bookmarks: Bookmark[], folderTerm: string): Bookmark[] {
    const [folderName, ...additionalTerms] = folderTerm.split(' ');
    const folderNameLower = folderName.toLowerCase();
    const additionalSearchTerm = additionalTerms.join(' ').toLowerCase();

    return bookmarks.filter(bm => 
      bm.folder && bm.folder.toLowerCase().includes(folderNameLower) &&
      (!additionalSearchTerm || bm.title.toLowerCase().includes(additionalSearchTerm))
    );
  }

  getAvailableFolders(bookmarks: Bookmark[]): string[] {
    const folders = new Set<string>();
    bookmarks.forEach(bm => {
      if (bm.folder) {
        folders.add(bm.folder);
      }
    });
    return Array.from(folders);
  }

  getMatchingFolders(bookmarks: Bookmark[], folderTerm: string): string[] {
    return this.getAvailableFolders(bookmarks).filter(folder => 
      folder.toLowerCase().includes(folderTerm.toLowerCase())
    );
  }

  // Cache management methods
  invalidateSearchCache(searchTerm?: string): void {
    this.cacheManager.invalidateSearchCache(searchTerm);
  }

  getCacheStats(): any {
    return this.cacheManager.getCacheStats();
  }

  clearAllCaches(): void {
    this.cacheManager.invalidateAllCaches();
  }
}
