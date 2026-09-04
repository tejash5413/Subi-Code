import { ProjectSearchResult, SearchMode } from '../types';
import { ProjectFileService } from './ProjectFileService';

export class ProjectSearchService {
  private readonly projectFileService: ProjectFileService;
  private static readonly LIMITS = {
    MIN_QUERY: 2,
    MAX_QUERY: 200,
    MAX_FILE_RESULTS: 100,
    MAX_CONTENT_RESULTS: 200,
    MAX_MATCHES_PER_FILE: 20,
    MAX_PREVIEW_CHARS: 200,
    CONCURRENCY: 8,
  };

  constructor(projectFileService: ProjectFileService) {
    this.projectFileService = projectFileService;
  }

  public dispose(): void {
    // No resources to dispose
  }

  private validateQuery(query: string): { valid: boolean; error?: string } {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return { valid: false, error: 'Search query cannot be empty.' };
    }
    if (trimmed.length < ProjectSearchService.LIMITS.MIN_QUERY) {
      return { valid: false, error: `Search query must be at least ${ProjectSearchService.LIMITS.MIN_QUERY} characters.` };
    }
    if (trimmed.length > ProjectSearchService.LIMITS.MAX_QUERY) {
      return { valid: false, error: `Search query must not exceed ${ProjectSearchService.LIMITS.MAX_QUERY} characters.` };
    }
    return { valid: true };
  }

  private getFilename(displayPath: string): string {
    const parts = displayPath.split('/');
    return parts[parts.length - 1] || displayPath;
  }

  private rankFileMatch(displayPath: string, queryLower: string): number {
    const filename = this.getFilename(displayPath).toLowerCase();
    const pathLower = displayPath.toLowerCase();

    if (filename.startsWith(queryLower)) {
      return 1000;
    }
    if (filename.includes(queryLower)) {
      return 100;
    }
    if (pathLower.includes(queryLower)) {
      return 10;
    }
    return 0;
  }

  public async searchFiles(query: string): Promise<ProjectSearchResult[]> {
    const validation = this.validateQuery(query);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const q = query.trim().toLowerCase();
    const files = await this.projectFileService.ensureFilesListed();

    const matches = files
      .filter((f) => f.displayPath.toLowerCase().includes(q))
      .map((f) => ({
        ...f,
        score: this.rankFileMatch(f.displayPath, q),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.displayPath.localeCompare(b.displayPath, undefined, { sensitivity: 'base' });
      })
      .slice(0, ProjectSearchService.LIMITS.MAX_FILE_RESULTS)
      .map((f) => ({
        fileId: f.id,
        displayPath: f.displayPath,
      }));

    return matches;
  }

  public async searchContent(query: string): Promise<ProjectSearchResult[]> {
    const validation = this.validateQuery(query);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const q = query.trim().toLowerCase();
    const files = await this.projectFileService.ensureFilesListed();

    const results: ProjectSearchResult[] = [];
    let totalResults = 0;
    let shouldStop = false;

    // Simple async queue with concurrency limit
    const queue = [...files];
    const workers = Array.from({ length: ProjectSearchService.LIMITS.CONCURRENCY }, async () => {
      while (queue.length > 0 && !shouldStop) {
        const file = queue.shift();
        if (!file) break;

        if (totalResults >= ProjectSearchService.LIMITS.MAX_CONTENT_RESULTS) {
          shouldStop = true;
          break;
        }

        const readResult = await this.projectFileService.readTextForSearch(file.id);
        if (!readResult.ok) {
          // Silently skip files that are too large, binary, or invalid
          continue;
        }

        const lines = readResult.content.split('\n');
        let fileMatchCount = 0;

        for (let i = 0; i < lines.length; i++) {
          if (totalResults >= ProjectSearchService.LIMITS.MAX_CONTENT_RESULTS) {
            shouldStop = true;
            break;
          }
          if (fileMatchCount >= ProjectSearchService.LIMITS.MAX_MATCHES_PER_FILE) {
            break;
          }

          const line = lines[i];
          if (line.toLowerCase().includes(q)) {
            const preview = line.trim().slice(0, ProjectSearchService.LIMITS.MAX_PREVIEW_CHARS);
            results.push({
              fileId: file.id,
              displayPath: file.displayPath,
              line: i + 1, // 1-based
              preview,
            });
            totalResults++;
            fileMatchCount++;
          }
        }
      }
    });

    await Promise.all(workers);

    // Ensure we never exceed the limit (defensive)
    if (results.length > ProjectSearchService.LIMITS.MAX_CONTENT_RESULTS) {
      return results.slice(0, ProjectSearchService.LIMITS.MAX_CONTENT_RESULTS);
    }

    return results;
  }
}