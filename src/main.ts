import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';
import { ConfigureOptions, Environment, Template } from 'nunjucks';
import { normalizePath, Plugin, TFile } from 'obsidian';
import spacetime from 'spacetime';
import * as YAML from 'yaml';

import { DEFAULT_SETTINGS, FRONTMATTER_TO_ESCAPE, YAML_TOSTRING_OPTIONS } from 'constants/index';
import { Export, Highlight, Library, Tag } from 'models/readwise';
import { PluginSettings } from 'models/settings';
import { YamlStringState } from 'models/yaml';
import ReadwiseApi from 'services/readwise-api';
import ReadwiseMirrorSettingTab from 'ui/settings-tab';
import Notify from 'ui/notify';
export default class ReadwiseMirror extends Plugin {
  settings: PluginSettings;
  readwiseApi: ReadwiseApi;
  notify: Notify;
  env: Environment;
  frontMatterTemplate: Template;
  headerTemplate: Template;
  highlightTemplate: Template;

  private analyzeStringForFrontmatter(value: string): YamlStringState {
    return {
      hasSingleQuotes: value.includes("'"),
      hasDoubleQuotes: value.includes('"'),
      isValueEscapedAlready:
        value.length > 1 &&
        ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))), // Basic YAML escape validation
    };
  }

  // Before metadata is used
  public escapeFrontmatter(metadata: any, fieldsToProcess: Array<string>): any {
    // Copy the metadata object to avoid modifying the original
    const processedMetadata = { ...metadata };
    fieldsToProcess.forEach((field) => {
      if (field in processedMetadata && processedMetadata[field] && typeof processedMetadata[field] === 'string') {
        processedMetadata[field] = this.escapeYamlValue(processedMetadata[field]);
      }
    });

    return processedMetadata;
  }

  private escapeYamlValue(value: string, multiline: boolean = false): string {
    if (!value) return '""';

    const state = this.analyzeStringForFrontmatter(value);

    // Already properly quoted and valid YAML
    if (state.isValueEscapedAlready) return value;

    // Handle multi-line strings
    if (value.includes('\n') && multiline) {
      // Use folded block style (>) for titles, preserve single line ending
      const indent = '  ';
      return `>-\n${indent}${value.replace(/\n/g, `\n${indent}`)}`;
    }

    value = value.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    // No quotes in string - use simple double quotes to catch other special characters
    if (!state.hasSingleQuotes && !state.hasDoubleQuotes) {
      return `"${value}"`;
    }

    // Has double quotes but no single quotes - use single quotes
    if (state.hasDoubleQuotes && !state.hasSingleQuotes) {
      return `'${value}'`;
    }

    // Has single quotes but no double quotes - use double quotes
    if (state.hasSingleQuotes && !state.hasDoubleQuotes) {
      return `"${value}"`;
    }

    // Has both types of quotes - escape double quotes and use double quotes
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  private formatTags(tags: Tag[], nohash: boolean = false, q: string = '') {
    // use unique list of tags
    const uniqueTags = [...new Set(tags.map((tag) => tag.name.replace(/\s/, '-')))];

    if (nohash) {
      // don't return a hash in the tag name
      return uniqueTags.map((tag) => `${q}${tag}${q}`).join(', ');
    } else {
      return uniqueTags.map((tag) => `${q}#${tag}${q}`).join(', ');
    }
  }

  private formatHighlight(highlight: Highlight, book: Export) {
    const { id, text, note, location, color, url, tags, highlighted_at, created_at, updated_at } = highlight;

    const locationUrl = `https://readwise.io/to_kindle?action=open&asin=${book['asin']}&location=${location}`;

    const formattedTags = tags.filter((tag) => tag.name !== color);
    const formattedTagStr = this.formatTags(formattedTags);

    return this.highlightTemplate.render({
      // Highlight fields
      id: id,
      text: text,
      note: note,
      location: location,
      location_url: locationUrl,
      url, // URL is set for source of highlight (webpage, tweet, etc). null for books
      color: color,
      created_at: created_at ? this.formatDate(created_at) : '',
      updated_at: updated_at ? this.formatDate(updated_at) : '',
      highlighted_at: highlighted_at ? this.formatDate(highlighted_at) : '',
      tags: formattedTagStr,

      // Book fields
      category: book.category,
    });
  }

  private highlightIsDiscarded = (highlight: Highlight) => {
    // is_discard is not a field in the API response for (https://readwise.io/api/v2/highlights/), so we need to check if the highlight has the discard tag
    // is_discard field only showing under the /export API endpoint in the API docs: https://readwise.io/api_deets

    return highlight.tags.some((tag) => tag.name === 'discard');
  };

  private filterHighlights(highlights: Highlight[]) {
    return highlights.filter((highlight: Highlight) => {
      if (this.settings.syncNotesOnly && !highlight.note) return false;

      // Check if is discarded
      if (this.settings.highlightDiscard && this.highlightIsDiscarded(highlight)) {
        console.debug('Readwise: Found discarded highlight, removing', highlight);
        return false;
      }

      return true;
    });
  }

  private formatDate(dateStr: string) {
    return dateStr.split('T')[0];
  }

  private sortHighlights = (highlights: Highlight[]) => {
    let sortedHighlights = highlights.slice();

    if (this.settings.highlightSortByLocation) {
      sortedHighlights = sortedHighlights.sort((highlightA: Highlight, highlightB: Highlight) => {
        if (highlightA.location < highlightB.location) return -1;
        else if (highlightA.location > highlightB.location) return 1;
        return 0;
      });

      if (!this.settings.highlightSortOldestToNewest) sortedHighlights = sortedHighlights.reverse();
    } else {
      sortedHighlights = this.settings.highlightSortOldestToNewest ? sortedHighlights.reverse() : sortedHighlights;
    }

    return sortedHighlights;
  };

  private getTagsFromHighlights(highlights: Highlight[]) {
    // extract all tags from all Highlights and
    // construct an array with unique values

    var tags: Tag[] = [];
    this.sortHighlights(highlights).forEach((highlight: Highlight) =>
      highlight.tags ? (tags = [...tags, ...highlight.tags]) : tags
    );
    return tags;
  }

  async writeLogToMarkdown(library: Library) {
    const vault = this.app.vault;

    let path = `${this.settings.baseFolderName}/${this.settings.logFileName}`;
    const abstractFile = vault.getAbstractFileByPath(path);

    const now = spacetime.now();
    let logString = `# [[${now.format('iso-short')}]] *(${now.time()})*`;

    for (let bookId in library['books']) {
      const book = library['books'][bookId];

      const { title, highlights } = book;
      const num_highlights = highlights.length;
      console.warn(`Readwise: Replacing colon with ${this.settings.colonSubstitute}`);
      const sanitizedTitle = `${title.replace(/:/g, this.settings.colonSubstitute).replace(/[<>"'\/\\|?*]+/g, '')}`;
      const contents = `\n- [[${sanitizedTitle}]] *(${num_highlights} highlights)*`;
      logString += contents;
    }

    try {
      if (abstractFile) {
        // If log file already exists, append to the content instead of overwriting
        const logFile = vault.getFiles().filter((file) => file.name === this.settings.logFileName)[0];
        console.log('logFile:', logFile);

        const logFileContents = await vault.read(logFile);
        vault.modify(logFile, logFileContents + '\n\n' + logString);
      } else {
        vault.create(path, logString);
      }
    } catch (err) {
      console.error(`Readwise: Error writing to sync log file`, err);
    }
  }

  /**
   * Writes updated frontmatter of a file with new values
   * @param file TFile to update
   * @param updates Record of key-value pairs to update/add in frontmatter
   * @returns Promise<void>
   *
   * Example:
   * ```typescript
   * await updateFrontmatter(file, {
   *   duplicate: true,
   *   lastUpdated: '2024-03-15'
   * });
   * ```
   *
   * Behavior:
   * - If file has no frontmatter, creates new frontmatter section
   * - If key exists, updates value (unless protected)
   * - If key doesn't exist, adds new key-value pair
   * - Preserves existing frontmatter formatting and values
   * - Maintains file content after frontmatter unchanged
   *
   * Protection:
   * - When frontmatter protection is enabled, specified fields are preserved
   * - Protected fields are not updated even if included in updates
   * - Protection is configured in plugin settings
   * - Example protected fields: status, tags, categories
   */
  private async writeUpdatedFrontmatter(file: TFile, updates: Record<string, any>): Promise<void> {
    let { frontmatter, body } = await this.updateFrontmatter(file, updates);

    // Combine and write back
    await this.app.vault.modify(file, `${frontmatter}\n${body}`);
  }

  private async updateFrontmatter(file: TFile, updates: Record<string, any>) {
    const content = await this.app.vault.read(file);
    const frontmatterRegex = /^(---\n[\s\S]*?\n---)/;
    const match = content.match(frontmatterRegex);

    let frontmatter = '';
    let body = content;

    // If frontmatter exists, update it
    if (match) {
      frontmatter = match[1];
      body = content.slice(match[0].length);

      // Parse existing frontmatter
      const currentFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};

      // Remove protected fields from updates (but only if they exist)
      if (this.settings.protectFrontmatter) {
        const protectedFields = this.settings.protectedFields
          .split('\n')
          .map((f) => f.trim())
          .filter((f) => f.length > 0);

        for (const field of protectedFields) {
          // only delete if the field is not present in currentFrontmatter
          if (field in currentFrontmatter) delete updates[field];
        }
      }

      // Create new frontmatter
      const newFrontmatter = {
        ...currentFrontmatter,
        ...updates,
      };

      frontmatter = ['---', YAML.stringify(newFrontmatter, YAML_TOSTRING_OPTIONS), '---'].join('\n');
    } else {
      frontmatter = ['---', YAML.stringify(updates, YAML_TOSTRING_OPTIONS), '---'].join('\n');
    }
    return { frontmatter, body };
  }

  private async findDuplicates(book: Export): Promise<TFile[]> {
    const canDeduplicate = this.settings.deduplicateFiles;

    if (!canDeduplicate) {
      return Promise.resolve([]);
    }

    // Fallback to MetadataCache if Dataview is not available
    const duplicateFiles: TFile[] = [];
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const metadata = this.app.metadataCache.getFileCache(file);
      if (metadata?.frontmatter?.[this.settings.deduplicateProperty] === book.readwise_url) {
        duplicateFiles.push(file);
      }
    }

    return duplicateFiles;
  }

  async writeLibraryToMarkdown(library: Library) {
    const vault = this.app.vault;

    // Create parent directories for all categories, if they do not exist
    library['categories'].forEach(async (category: string) => {
      category = category.charAt(0).toUpperCase() + category.slice(1); // Title Case the directory name

      // TODO: deal with case sensitiveness – getAbstractFileByPath is *case sensitive* but `vault.create()` is not
      const path = `${this.settings.baseFolderName}/${category}`;
      const abstractFolder = vault.getAbstractFileByPath(path);

      if (!abstractFolder) {
        vault.createFolder(path);
        console.info('Readwise: Successfully created folder', path);
      }
    });

    // Get total number of records
    const booksTotal = Object.keys(library.books).length;
    let bookCurrent = 1;
    for (let bookId in library['books']) {
      this.notify.setStatusBarText(
        `Readwise: Processing - ${Math.floor(
          (bookCurrent / booksTotal) * 100
        )}% finished (${bookCurrent}/${booksTotal})`
      );
      bookCurrent += 1;
      const book: Export = library['books'][bookId];

      const {
        user_book_id,
        title,
        document_note,
        summary,
        author,
        category,
        cover_image_url,
        highlights,
        readwise_url,
        source_url,
        unique_url,
        book_tags,
      } = book;

      // Get highlight count
      const num_highlights = highlights.length;
      const created = highlights
        .map(function (highlight) {
          return highlight.created_at;
        })
        .sort()[0]; // No reverse sort: we want the oldest entry
      const updated = highlights
        .map(function (highlight) {
          return highlight.updated_at;
        })
        .sort()
        .reverse()[0];
      const last_highlight_at = highlights
        .map(function (highlight) {
          return highlight.highlighted_at;
        })
        .sort()
        .reverse()[0];

      // Sanitize title, replace colon with substitute from settings
      const sanitizedTitle = this.settings.useSlugify
        ? slugify(title.replace(/:/g, this.settings.colonSubstitute ?? '-'), {
            separator: this.settings.slugifySeparator,
            lowercase: this.settings.slugifyLowercase,
          })
        : // ... else filenamify the title
          filenamify(title.replace(/:/g, this.settings.colonSubstitute ?? '-'), {
            replacement: ' ',
            maxLength: 255,
          }) // Ensure we remove additional critical characters, replace multiple spaces with one, and trim
            .replace(/[<>"'\/\\|?*#]+/g, '')
            .replace(/ +/g, ' ')
            .trim();

      // Filter highlights
      const filteredHighlights = this.filterHighlights(highlights);

      if (filteredHighlights.length === 0) {
        console.debug(`Readwise: No highlights found for '${title}' (${source_url})`);
      } else {
        const formattedHighlights = this.sortHighlights(filteredHighlights)
          .map((highlight: Highlight) => this.formatHighlight(highlight, book))
          .join('\n');

        // get an array with all tags from highlights
        const highlightTags = this.getTagsFromHighlights(filteredHighlights);
        const authors = author ? author.split(/and |,/) : [];

        let authorStr =
          authors[0] && authors?.length > 1
            ? authors
                .filter((authorName: string) => authorName.trim() != '')
                .map((authorName: string) => `[[${authorName.trim()}]]`)
                .join(', ')
            : author
            ? `[[${author}]]`
            : ``;

        const metadata = {
          id: user_book_id,
          title: title,
          sanitized_title: sanitizedTitle,
          author: author,
          authorStr: authorStr,
          document_note: document_note,
          summary: summary,
          category: category,
          num_highlights: num_highlights,
          created: created ? this.formatDate(created) : '',
          updated: updated ? this.formatDate(updated) : '',
          cover_image_url: cover_image_url.replace('SL200', 'SL500').replace('SY160', 'SY500'),
          highlights_url: readwise_url,
          highlights: highlights,
          last_highlight_at: last_highlight_at ? this.formatDate(last_highlight_at) : '',
          source_url: source_url,
          unique_url: unique_url,
          tags: this.formatTags(book_tags),
          highlight_tags: this.formatTags(highlightTags),
          tags_nohash: this.formatTags(book_tags, true, "'"),
          hl_tags_nohash: this.formatTags(highlightTags, true, "'"),
        };

        // Escape specific fields used in frontmatter
        // TODO: Tidy up code. It doesn't make sense to remove the frontmatter markers and then add them back
        const frontmatterYaml = YAML.parse(
          this.frontMatterTemplate
            .render(this.escapeFrontmatter(metadata, FRONTMATTER_TO_ESCAPE))
            .replace(/^---\n/, '')
            .replace(/\n---\n*$/, '')
        );
        const frontMatterContents = this.settings.frontMatter
          ? ['---', YAML.stringify(frontmatterYaml, YAML_TOSTRING_OPTIONS), '---'].join('\n')
          : '';
        const headerContents = this.headerTemplate.render(metadata);
        const contents = `${frontMatterContents}${headerContents}${formattedHighlights}`;

        let path = `${this.settings.baseFolderName}/${
          category.charAt(0).toUpperCase() + category.slice(1)
        }/${sanitizedTitle}.md`;

        const abstractFile = vault.getAbstractFileByPath(normalizePath(path));

        // Try to find duplicates: local duplicates (e.g. copies of files), and remote duplicates (e.g. readwise items with the same title)
        try {
          const duplicates = await this.findDuplicates(book);

          // Deduplicate files
          if (duplicates.length > 0) {
            let deduplicated = false;
            let filesToDeleteOrLabel: TFile[] = [];

            // First: Check if target file is in duplicates (i.e. has the same name)
            const targetFileIndex = duplicates.findIndex((f) => f.path === path);
            if (targetFileIndex >= 0 && abstractFile instanceof TFile) {
              deduplicated = true;
              // Update target file
              try {
                // Update frontmatter if enabled
                if (this.settings.updateFrontmatter) {
                  const { frontmatter } = await this.updateFrontmatter(abstractFile, frontmatterYaml);
                  const contents = `${frontmatter}${headerContents}${formattedHighlights}`;
                  await vault.process(abstractFile, () => contents);
                } else await vault.process(abstractFile, () => contents);
              } catch (err) {
                console.error(`Readwise: Attempt to overwrite file ${path} failed`, err);
                this.notify.notice(`Readwise: Failed to update file '${path}'. ${err}`);
              } finally {
                // Remove target file from duplicates
                duplicates.splice(targetFileIndex, 1);
              }
            }

            // Second: Handle remaining duplicates (if any)
            if (duplicates.length > 0) {
              // Keep first duplicate if we haven't updated a file yet, and write it
              if (!deduplicated && duplicates[0]) {
                try {
                  // Write the new contents to the first duplicate
                  if (this.settings.updateFrontmatter) {
                    await this.updateFrontmatter(duplicates[0], frontmatterYaml).then(({ frontmatter }) => {
                      const contents = `${frontmatter}${headerContents}${formattedHighlights}`;
                      vault
                        .process(duplicates[0], () => contents)
                        .then(() => {
                          deduplicated = true;
                        });
                    });
                  } else
                    await vault
                      .process(duplicates[0], () => contents)
                      .then(() => {
                        deduplicated = true;
                      });

                  // Rename the file if we have updated it
                  await this.app.fileManager.renameFile(duplicates[0], path).catch(async () => {
                    // We couldn't rename – check if we happen to have a file with "identical" (case-insenstivie) names
                    if (vault.adapter.exists(normalizePath(path))) {
                      // Replace the sanitized title
                      const incrementPath = path.replace(`${sanitizedTitle}.md`, `${sanitizedTitle} ${metadata.id}.md`);
                      if (incrementPath !== path) {
                        await this.app.fileManager.renameFile(duplicates[0], incrementPath);
                        console.warn(`Readwise: Processed remote duplicate ${incrementPath}`);
                        this.notify.notice(`Readwise: Processed remote duplicate into ${incrementPath}`);
                      } else {
                        console.warn(
                          `Readwise: file '${await vault.create(
                            path,
                            contents
                          )}' for remote duplicate will not be renamed.`
                        );
                      }
                    }
                  });
                  // Remove the file we just updated from duplicates
                  duplicates.shift();
                } catch (err) {
                  // Verify if file exists: if yes, we might have a duplicate in Readwise (i.e. same title (minus case))
                  console.error(`Readwise: Failed to rename local duplicate ${duplicates[0].path}`, err);
                  this.notify.notice(`Readwise: Failed to rename local duplicate ${duplicates[0].path}`);
                }
              }
              // Add remaining duplicates to deletion list
              filesToDeleteOrLabel.push(...duplicates);
            }

            // Delete extra duplicates or mark as "duplicate" in the Vault
            for (const file of filesToDeleteOrLabel) {
              try {
                if (this.settings.deleteDuplicates) {
                  await vault.trash(file, true);
                } else {
                  await this.writeUpdatedFrontmatter(file, { ...frontmatterYaml, duplicate: true });
                }
              } catch (err) {
                console.error(`Readwise: Failed to delete local duplicate ${file.path}`, err);
                this.notify.notice(`Readwise: Failed to delete local duplicate ${file.path}`);
              }
            }
          }
          // Overwrite existing file with remote changes, or
          // Create new file if not existing
          else if (abstractFile && abstractFile instanceof TFile) {
            // File exists
            try {
              // Update frontmatter if enabled
              if (this.settings.updateFrontmatter) {
                const { frontmatter } = await this.updateFrontmatter(abstractFile, frontmatterYaml);
                const contents = `${frontmatter}${headerContents}${formattedHighlights}`;
                await vault.process(abstractFile, () => contents);
              } else await vault.process(abstractFile, () => contents);
            } catch (err) {
              console.error(`Readwise: Attempt to overwrite file ${path} failed`, err);
              this.notify.notice(`Readwise: Failed to update file '${path}'. ${err}`);
            }
          } else {
            try {
              // File does not exist
              await vault.create(path, contents).catch(async () => {
                // We might have a file that already exists but with different cased filename … check
                if (vault.adapter.exists(normalizePath(path))) {
                  // Replace the sanitized title
                  const incrementPath = path.replace(`${sanitizedTitle}.md`, `${sanitizedTitle} ${metadata.id}.md`);
                  await vault.create(incrementPath, contents);
                  console.warn(`Readwise: Processed remote duplicate ${incrementPath}`);
                  this.notify.notice(`Readwise: Processed remote duplicate into ${incrementPath}`);
                }
              });
            } catch (err) {
              console.error(
                `Readwise: Attempt to create file ${path} *DE NOVO* failed (uri: ${metadata.highlights_url})`,
                err
              );
              this.notify.notice(`Readwise: Failed to create file '${path}'. ${err}`);
            }
          }
        } catch (err) {
          console.error(`Readwise: Writing file ${path} (${metadata.highlights_url}) failed`, err);
          this.notify.notice(`Readwise: Writing to '${path}' failed. ${err}`);
        }
      }
    }
  }

  async deleteLibraryFolder() {
    const vault = this.app.vault;
    let path = `${this.settings.baseFolderName}`;

    const abstractFile = vault.getAbstractFileByPath(path);

    // Delete old instance of file
    if (abstractFile) {
      try {
        console.info('Readwise: Attempting to delete entire library at:', abstractFile);
        await vault.delete(abstractFile, true);
        return true;
      } catch (err) {
        console.error(`Readwise: Attempted to delete file ${path} but no file was found`, err);
        return false;
      }
    }
  }

  async sync() {
    if (!this.settings.apiToken) {
      this.notify.notice('Readwise: API Token Required');
      return;
    }

    let library: Library;
    const lastUpdated = this.settings.lastUpdated;

    if (!lastUpdated) {
      this.notify.notice('Readwise: Previous sync not detected...\nDownloading full Readwise library');
      library = await this.readwiseApi.downloadFullLibrary();
    } else {
      // Load Upadtes and cache
      this.notify.notice(`Readwise: Checking for new updates since ${this.lastUpdatedHumanReadableFormat()}`);
      library = await this.readwiseApi.downloadUpdates(lastUpdated);
    }

    if (Object.keys(library.books).length > 0) {
      this.writeLibraryToMarkdown(library);

      if (this.settings.logFile) this.writeLogToMarkdown(library);

      this.notify.notice(
        `Readwise: Downloaded ${library.highlightCount} Highlights from ${Object.keys(library.books).length} Sources`
      );
    } else {
      this.notify.notice(`Readwise: No new content available`);
    }

    this.settings.lastUpdated = new Date().toISOString();
    await this.saveSettings();
    this.notify.setStatusBarText(`Readwise: Synced ${this.lastUpdatedHumanReadableFormat()}`);
  }

  async download() {
    // Reset lastUpdate setting to force full download
    this.settings.lastUpdated = null;
    await this.saveSettings();
    await this.sync();
  }

  async deleteLibrary() {
    this.settings.lastUpdated = null;
    await this.saveSettings();

    if (await this.deleteLibraryFolder()) {
      this.notify.notice('Readwise: library folder deleted');
    } else {
      this.notify.notice('Readwise: Error deleting library folder');
    }

    this.notify.setStatusBarText('Readwise: Click to Sync');
  }

  lastUpdatedHumanReadableFormat() {
    return spacetime.now().since(spacetime(this.settings.lastUpdated)).rounded;
  }

  // Reload settings after external change (e.g. after sync)
  async onExternalSettingsChange() {
    console.info(`Reloading settings due to external change`);
    await this.loadSettings();
    if (this.settings.lastUpdated)
      this.notify.setStatusBarText(`Readwise: Updated ${this.lastUpdatedHumanReadableFormat()} elsewhere`);
  }

  public ensureDedupPropertyInTemplate(template: string): string {
    if (!this.settings.deduplicateFiles) return template;

    const propertyName = this.settings.deduplicateProperty;
    const propertyValue = `${propertyName}: {{ highlights_url }}`;

    const lines = template.split('\n');
    const frontmatterStart = lines.findIndex((line) => line.trim() === '---');
    const frontmatterEnd =
      lines.slice(frontmatterStart + 1).findIndex((line) => line.trim() === '---') + frontmatterStart + 1;

    if (frontmatterStart === -1 || frontmatterEnd <= frontmatterStart) return template;

    // Check for existing property
    const propertyIndex = lines.findIndex((line) => line.trim().startsWith(`${propertyName}:`));

    if (propertyIndex > -1 && propertyIndex < frontmatterEnd) {
      // Replace existing property
      console.warn(`Readwise: Replacing existing property '${propertyName}' in frontmatter template for deduplication`);
      lines[propertyIndex] = propertyValue;
    } else {
      // Add new property before closing ---
      lines.splice(frontmatterEnd, 0, propertyValue);
    }

    return lines.join('\n');
  }

  async onload() {
    await this.loadSettings();

    const statusBarItem = this.addStatusBarItem();

    // Setup templating
    this.env = new Environment(null, { autoescape: false } as ConfigureOptions);

    // Add a nunjucks filter to convert newlines to "newlines + >" for quotes
    this.env.addFilter('bq', function (str) {
      return str.replace(/\r|\n|\r\n/g, '\r\n> ');
    });

    // Add a nunjukcs filter to test whether we are a ".qa" note
    this.env.addFilter('is_qa', function (str) {
      return str.includes('.qa');
    });

    // Add a nunjucks filter to convert ".qa" notes to Q& A
    this.env.addFilter('qa', function (str) {
      return str.replace(/\.qa(.*)\?(.*)/g, '**Q:**$1?\r\n\r\n**A:**$2');
    });

    // Add filter to nunjucks environment
    this.env.addFilter('yaml', function (str) {
      return this.escapeForYaml(str);
    });

    this.frontMatterTemplate = new Template(
      this.ensureDedupPropertyInTemplate(this.settings.frontMatterTemplate),
      this.env,
      null,
      true
    );
    this.headerTemplate = new Template(this.settings.headerTemplate, this.env, null, true);
    this.highlightTemplate = new Template(this.settings.highlightTemplate, this.env, null, true);

    this.notify = new Notify(statusBarItem);

    if (!this.settings.apiToken) {
      this.notify.notice('Readwise: API Token not detected\nPlease enter in configuration page');
      this.notify.setStatusBarText('Readwise: API Token Required');
    } else {
      this.readwiseApi = new ReadwiseApi(this.settings.apiToken, this.notify);
      if (this.settings.lastUpdated)
        this.notify.setStatusBarText(`Readwise: Updated ${this.lastUpdatedHumanReadableFormat()}`);
      else this.notify.setStatusBarText(`Readwise: Click to Sync`);
    }

    this.registerDomEvent(statusBarItem, 'click', this.sync.bind(this));

    this.addCommand({
      id: 'download',
      name: 'Download entire Readwise library (force)',
      callback: this.download.bind(this),
    });

    this.addCommand({
      id: 'test',
      name: 'Test Readwise API key',
      callback: async () => {
        const isTokenValid = await this.readwiseApi.checkToken();
        this.notify.notice('Readwise: ' + (isTokenValid ? 'Token is valid' : 'INVALID TOKEN'));
      },
    });

    this.addCommand({
      id: 'delete',
      name: 'Delete Readwise library',
      callback: this.deleteLibrary.bind(this),
    });

    this.addCommand({
      id: 'update',
      name: 'Sync new highlights',
      callback: this.sync.bind(this),
    });

    this.registerInterval(
      window.setInterval(() => {
        if (/Synced/.test(this.notify.getStatusBarText())) {
          this.notify.setStatusBarText(`Readwise: Synced ${this.lastUpdatedHumanReadableFormat()}`);
        }
      }, 1000)
    );

    this.addSettingTab(new ReadwiseMirrorSettingTab(this.app, this, this.notify));

    if (this.settings.autoSync) this.sync();
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
