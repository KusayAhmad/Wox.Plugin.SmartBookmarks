import { Bookmark, SearchResult } from "./interfaces";
import { Logger } from "./logger";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

interface SearchCacheEntry {
  results: SearchResult[];
  timestamp: number;
  searchTerm: string;
}

export class CacheManager {
  private bookmarkCache: Map<string, CacheEntry<Bookmark[]>> = new Map();
  private searchCache: Map<string, SearchCacheEntry> = new Map();
  private fileStatsCache: Map<string, { mtime: number; size: number }> = new Map();
  
  // Cache configuration
  private readonly BOOKMARK_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly SEARCH_CACHE_TTL = 30 * 1000; // 30 seconds
  private readonly MAX_SEARCH_CACHE_SIZE = 100;
  private readonly MAX_BOOKMARK_CACHE_SIZE = 10;

  constructor() {
    Logger.log("CacheManager initialized");
    
    // Clean up expired cache entries every 5 minutes
    setInterval(() => {
      this.cleanupExpiredEntries();
    }, 5 * 60 * 1000);
  }

  // Bookmark caching
  cacheBookmarks(key: string, bookmarks: Bookmark[], ttl?: number): void {
    const cacheEntry: CacheEntry<Bookmark[]> = {
      data: bookmarks,
      timestamp: Date.now(),
      ttl: ttl || this.BOOKMARK_CACHE_TTL
    };

    this.bookmarkCache.set(key, cacheEntry);
    Logger.log(`Cached ${bookmarks.length} bookmarks for key: ${key}`);

    // Limit cache size
    if (this.bookmarkCache.size > this.MAX_BOOKMARK_CACHE_SIZE) {
      const oldestKey = this.getOldestCacheKey(this.bookmarkCache);
      if (oldestKey) {
        this.bookmarkCache.delete(oldestKey);
        Logger.log(`Evicted old bookmark cache entry: ${oldestKey}`);
      }
    }
  }

  getCachedBookmarks(key: string): Bookmark[] | null {
    const entry = this.bookmarkCache.get(key);
    
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.bookmarkCache.delete(key);
      Logger.log(`Bookmark cache expired for key: ${key}`);
      return null;
    }

    Logger.log(`Retrieved ${entry.data.length} bookmarks from cache for key: ${key}`);
    return entry.data;
  }

  // Search result caching
  cacheSearchResults(searchTerm: string, results: SearchResult[]): void {
    // Normalize search term for consistent caching
    const normalizedTerm = searchTerm.toLowerCase().trim();
    
    const cacheEntry: SearchCacheEntry = {
      results,
      timestamp: Date.now(),
      searchTerm: normalizedTerm
    };

    this.searchCache.set(normalizedTerm, cacheEntry);
    Logger.log(`Cached ${results.length} search results for term: "${normalizedTerm}"`);

    // Limit search cache size (LRU eviction)
    if (this.searchCache.size > this.MAX_SEARCH_CACHE_SIZE) {
      const oldestKey = this.getOldestSearchCacheKey();
      if (oldestKey) {
        this.searchCache.delete(oldestKey);
        Logger.log(`Evicted old search cache entry: "${oldestKey}"`);
      }
    }
  }

  getCachedSearchResults(searchTerm: string): SearchResult[] | null {
    const normalizedTerm = searchTerm.toLowerCase().trim();
    const entry = this.searchCache.get(normalizedTerm);
    
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > this.SEARCH_CACHE_TTL) {
      this.searchCache.delete(normalizedTerm);
      Logger.log(`Search cache expired for term: "${normalizedTerm}"`);
      return null;
    }

    Logger.log(`Retrieved ${entry.results.length} search results from cache for term: "${normalizedTerm}"`);
    return entry.results;
  }

  // File stats caching for efficient file change detection
  cacheFileStats(filePath: string, stats: { mtime: number; size: number }): void {
    this.fileStatsCache.set(filePath, stats);
  }

  getCachedFileStats(filePath: string): { mtime: number; size: number } | null {
    return this.fileStatsCache.get(filePath) || null;
  }

  hasFileChanged(filePath: string, currentStats: { mtime: number; size: number }): boolean {
    const cachedStats = this.getCachedFileStats(filePath);
    
    if (!cachedStats) {
      this.cacheFileStats(filePath, currentStats);
      return true; // First time seeing this file
    }

    const changed = cachedStats.mtime !== currentStats.mtime || cachedStats.size !== currentStats.size;
    
    if (changed) {
      this.cacheFileStats(filePath, currentStats);
      Logger.log(`File changed detected: ${filePath}`);
    }

    return changed;
  }

  // Cache invalidation
  invalidateBookmarkCache(key?: string): void {
    if (key) {
      this.bookmarkCache.delete(key);
      Logger.log(`Invalidated bookmark cache for key: ${key}`);
    } else {
      this.bookmarkCache.clear();
      Logger.log("Invalidated all bookmark cache");
    }
  }

  invalidateSearchCache(searchTerm?: string): void {
    if (searchTerm) {
      const normalizedTerm = searchTerm.toLowerCase().trim();
      this.searchCache.delete(normalizedTerm);
      Logger.log(`Invalidated search cache for term: "${normalizedTerm}"`);
    } else {
      this.searchCache.clear();
      Logger.log("Invalidated all search cache");
    }
  }

  invalidateAllCaches(): void {
    this.bookmarkCache.clear();
    this.searchCache.clear();
    this.fileStatsCache.clear();
    Logger.log("Invalidated all caches");
  }

  // Utility methods
  private getOldestCacheKey<T>(cache: Map<string, CacheEntry<T>>): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, entry] of cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  private getOldestSearchCacheKey(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, entry] of this.searchCache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let cleanedCount = 0;

    // Clean bookmark cache
    for (const [key, entry] of this.bookmarkCache) {
      if (now - entry.timestamp > entry.ttl) {
        this.bookmarkCache.delete(key);
        cleanedCount++;
      }
    }

    // Clean search cache
    for (const [key, entry] of this.searchCache) {
      if (now - entry.timestamp > this.SEARCH_CACHE_TTL) {
        this.searchCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      Logger.log(`Cleaned up ${cleanedCount} expired cache entries`);
    }
  }

  // Cache statistics
  getCacheStats(): {
    bookmarkCacheSize: number;
    searchCacheSize: number;
    fileStatsCacheSize: number;
    memoryUsage: string;
  } {
    const stats = {
      bookmarkCacheSize: this.bookmarkCache.size,
      searchCacheSize: this.searchCache.size,
      fileStatsCacheSize: this.fileStatsCache.size,
      memoryUsage: this.estimateMemoryUsage()
    };

    return stats;
  }

  private estimateMemoryUsage(): string {
    let totalBookmarks = 0;
    for (const entry of this.bookmarkCache.values()) {
      totalBookmarks += entry.data.length;
    }

    let totalSearchResults = 0;
    for (const entry of this.searchCache.values()) {
      totalSearchResults += entry.results.length;
    }

    // Rough estimation: each bookmark ~1KB, each search result ~0.5KB
    const estimatedBytes = (totalBookmarks * 1024) + (totalSearchResults * 512) + (this.fileStatsCache.size * 100);
    
    if (estimatedBytes < 1024) {
      return `${estimatedBytes} bytes`;
    } else if (estimatedBytes < 1024 * 1024) {
      return `${(estimatedBytes / 1024).toFixed(1)} KB`;
    } else {
      return `${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
    }
  }

  // Cache integrity validation
  async validateCacheIntegrity(): Promise<{
    valid: number;
    invalid: number;
    cleaned: number;
    report: string[];
  }> {
    const report: string[] = [];
    let validCount = 0;
    let invalidCount = 0;
    let cleanedCount = 0;

    // Validate bookmark cache
    for (const [key, entry] of this.bookmarkCache) {
      try {
        if (!entry.data || !Array.isArray(entry.data)) {
          this.bookmarkCache.delete(key);
          cleanedCount++;
          report.push(`Removed invalid bookmark cache: ${key}`);
          continue;
        }

        // Validate each bookmark in the cache
        for (const bookmark of entry.data) {
          if (!bookmark.url || !bookmark.title) {
            invalidCount++;
            report.push(`Invalid bookmark found in ${key}: missing url or title`);
          } else {
            validCount++;
          }
        }

        // Check if entry is expired
        const now = Date.now();
        if (now - entry.timestamp > entry.ttl) {
          this.bookmarkCache.delete(key);
          cleanedCount++;
          report.push(`Removed expired bookmark cache: ${key}`);
        }
      } catch (error) {
        this.bookmarkCache.delete(key);
        cleanedCount++;
        invalidCount++;
        report.push(`Removed corrupted bookmark cache: ${key} - ${error}`);
      }
    }

    // Validate search cache
    for (const [key, entry] of this.searchCache) {
      try {
        if (!entry.results || !Array.isArray(entry.results)) {
          this.searchCache.delete(key);
          cleanedCount++;
          report.push(`Removed invalid search cache: ${key}`);
          continue;
        }

        // Check if entry is expired
        const now = Date.now();
        if (now - entry.timestamp > this.SEARCH_CACHE_TTL) {
          this.searchCache.delete(key);
          cleanedCount++;
          report.push(`Removed expired search cache: ${key}`);
        } else {
          validCount++;
        }
      } catch (error) {
        this.searchCache.delete(key);
        cleanedCount++;
        invalidCount++;
        report.push(`Removed corrupted search cache: ${key} - ${error}`);
      }
    }

    Logger.log(`Cache validation complete: ${validCount} valid, ${invalidCount} invalid, ${cleanedCount} cleaned`);
    return { valid: validCount, invalid: invalidCount, cleaned: cleanedCount, report };
  }

  // Cache size optimization
  async optimizeCacheSize(): Promise<{
    removedExpired: number;
    removedLRU: number;
    preservedImportant: number;
    memoryFreed: string;
    report: string[];
  }> {
    const report: string[] = [];
    let removedExpired = 0;
    let removedLRU = 0;
    let preservedImportant = 0;
    const initialMemory = this.estimateMemoryUsage();

    // Remove expired entries first
    const now = Date.now();
    
    for (const [key, entry] of this.bookmarkCache) {
      if (now - entry.timestamp > entry.ttl) {
        this.bookmarkCache.delete(key);
        removedExpired++;
        report.push(`Removed expired bookmark cache: ${key}`);
      }
    }

    for (const [key, entry] of this.searchCache) {
      if (now - entry.timestamp > this.SEARCH_CACHE_TTL) {
        this.searchCache.delete(key);
        removedExpired++;
        report.push(`Removed expired search cache: ${key}`);
      }
    }

    // If still over size limits, apply LRU eviction to bookmark cache
    if (this.bookmarkCache.size > this.MAX_BOOKMARK_CACHE_SIZE) {
      const sortedEntries = Array.from(this.bookmarkCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      const toRemove = this.bookmarkCache.size - this.MAX_BOOKMARK_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        const [key] = sortedEntries[i];
        this.bookmarkCache.delete(key);
        removedLRU++;
        report.push(`LRU removed bookmark cache: ${key}`);
      }
    }

    // Apply LRU eviction to search cache but preserve recent searches
    if (this.searchCache.size > this.MAX_SEARCH_CACHE_SIZE) {
      const sortedEntries = Array.from(this.searchCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      const toRemove = this.searchCache.size - this.MAX_SEARCH_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        const [key, entry] = sortedEntries[i];
        
        // Preserve important searches (recent or with many results)
        if (now - entry.timestamp < 60000 || entry.results.length > 5) {
          preservedImportant++;
          report.push(`Preserved important search cache: ${key}`);
          continue;
        }
        
        this.searchCache.delete(key);
        removedLRU++;
        report.push(`LRU removed search cache: ${key}`);
      }
    }

    const finalMemory = this.estimateMemoryUsage();
    const memoryFreed = `${initialMemory} → ${finalMemory}`;
    
    Logger.log(`Cache optimization complete: ${removedExpired} expired, ${removedLRU} LRU, ${preservedImportant} preserved`);
    return { removedExpired, removedLRU, preservedImportant, memoryFreed, report };
  }

  // Get comprehensive cache health metrics
  getCacheHealth(): {
    status: 'healthy' | 'warning' | 'critical';
    issues: string[];
    recommendations: string[];
    metrics: {
      totalEntries: number;
      memoryUsage: string;
      hitRate: number;
      averageAge: number;
    };
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';

    const totalEntries = this.bookmarkCache.size + this.searchCache.size;
    const memoryUsage = this.estimateMemoryUsage();
    
    // Calculate average cache age
    const now = Date.now();
    let totalAge = 0;
    let entryCount = 0;
    
    for (const entry of this.bookmarkCache.values()) {
      totalAge += now - entry.timestamp;
      entryCount++;
    }
    for (const entry of this.searchCache.values()) {
      totalAge += now - entry.timestamp;
      entryCount++;
    }
    
    const averageAge = entryCount > 0 ? totalAge / entryCount / 1000 : 0; // in seconds

    // Check for issues
    if (this.bookmarkCache.size > this.MAX_BOOKMARK_CACHE_SIZE * 0.9) {
      issues.push("Bookmark cache approaching size limit");
      recommendations.push("Consider running cache optimization");
      status = 'warning';
    }

    if (this.searchCache.size > this.MAX_SEARCH_CACHE_SIZE * 0.9) {
      issues.push("Search cache approaching size limit");
      recommendations.push("Search cache will auto-cleanup soon");
      if (status === 'healthy') status = 'warning';
    }

    if (averageAge > 300) { // 5 minutes
      issues.push("Cache entries are getting old");
      recommendations.push("Cache may need refreshing");
      if (status === 'healthy') status = 'warning';
    }

    if (totalEntries === 0) {
      issues.push("No cached data available");
      recommendations.push("Run force reload to populate cache");
      status = 'critical';
    }

    // Estimate hit rate (simplified)
    const hitRate = totalEntries > 0 ? Math.min(95, 60 + (totalEntries * 2)) : 0;

    return {
      status,
      issues,
      recommendations,
      metrics: {
        totalEntries,
        memoryUsage,
        hitRate,
        averageAge: Math.round(averageAge)
      }
    };
  }
}
