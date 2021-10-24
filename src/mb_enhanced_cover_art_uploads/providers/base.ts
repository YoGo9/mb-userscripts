import { filterNonNull, groupBy } from '@lib/util/array';
import { parseDOM, qs } from '@lib/util/dom';
import { gmxhr } from '@lib/util/xhr';

export abstract class CoverArtProvider {
    /**
     * Domains supported by the provider, without www. Domains such as
     * `*.domain.tld` mean "any subdomain of domain.tld, including domain.tld
     * itself", whereas a bare `domain.tld` only matches `domain.tld`. Wildcard
     * must be the first part of the pattern. In case of multiple providers with
     * the same patterns, more specific takes precedence, e.g. for domain
     * `abc.example.xyz`, a provider with domain pattern `abc.example.xyz` wins
     * from one with `*.example.xyz`. Similarly, for domain `example.com`, a
     * provider with the pattern `example.com` wins from one with `*.example.com`.
     */
    abstract supportedDomains: string[]
    /**
     * URL of the provider's favicon, for use in import buttons.
     */
    abstract get favicon(): string
    /**
     * Provider name, used in import buttons.
     */
    abstract name: string

    /**
     * Regular expression used to both match supported URLs and extract ID
     * from the URL. Matched against the full URL.
     */
    abstract readonly urlRegex: RegExp | RegExp[]

    /**
     * Find the provider's images.
     *
     * @param      {string}     url     The URL to the release. Guaranteed to have passed validation.
     * @return     {Promise<CoverArt[]>}  List of cover arts that should be imported.
     */
    abstract findImages(url: URL): Promise<CoverArt[]>

    /**
     * Returns a clean version of the given URL.
     * This version should be used to match against `urlRegex`.
     */
    cleanUrl(url: URL): string {
        return url.host + url.pathname;
    }

    /**
     * Check whether the provider supports the given URL.
     *
     * @param      {URL}    url     The provider URL.
     * @return     {boolean}  Whether images can be extracted for this URL.
     */
    supportsUrl(url: URL): boolean {
        if (Array.isArray(this.urlRegex)) {
            return this.urlRegex.some((regex) => regex.test(this.cleanUrl(url)));
        }
        return this.urlRegex.test(this.cleanUrl(url));
    }

    /**
     * Extract ID from a release URL.
     */
    extractId(url: URL): string | undefined {
        if (!Array.isArray(this.urlRegex)) {
            return this.cleanUrl(url).match(this.urlRegex)?.[1];
        }

        return this.urlRegex
            .map((regex) => this.cleanUrl(url).match(regex)?.[1])
            .find((id) => typeof id !== 'undefined');
    }

    /**
     * Check whether a redirect is safe, i.e. both URLs point towards the same
     * release.
     */
    isSafeRedirect(originalUrl: URL, redirectedUrl: URL): boolean {
        const id = this.extractId(originalUrl);
        return !!id && id === this.extractId(redirectedUrl);
    }

    async fetchPage(url: URL): Promise<string> {
        const resp = await gmxhr(url);
        if (resp.finalUrl !== url.href && !this.isSafeRedirect(url, new URL(resp.finalUrl))) {
            throw new Error(`Refusing to extract images from ${this.name} provider because the original URL redirected to ${resp.finalUrl}, which may be a different release. If this redirected URL is correct, please retry with ${resp.finalUrl} directly.`);
        }

        return resp.responseText;
    }

    protected mergeTrackImages(trackImages: Array<ParsedTrackImage | undefined>, mainUrl: string): CoverArt[] {
        const newTrackImages = filterNonNull(trackImages)
            // Filter out tracks that have the same image as the main release.
            .filter((img) => img.url !== mainUrl);
        const imgUrlToTrackNumber = groupBy(newTrackImages, (el) => el.url, (el) => el.trackNumber);

        const results: CoverArt[] = [];
        imgUrlToTrackNumber.forEach((trackNumbers, imgUrl) => {
            results.push({
                url: new URL(imgUrl),
                types: [ArtworkTypeIDs.Track],
                // Use comment to indicate which tracks this applies to.
                comment: this.#createTrackImageComment(trackNumbers),
            });
        });

        return results;
    }

    #createTrackImageComment(trackNumbers: Array<string | undefined>): string | undefined {
        const definedTrackNumbers = filterNonNull(trackNumbers);
        /* istanbul ignore if: Can't find case */
        if (!definedTrackNumbers.length) return;

        /* istanbul ignore next: Can't find case with multiple */
        const prefix = definedTrackNumbers.length === 1 ? 'Track' : 'Tracks';
        return `${prefix} ${definedTrackNumbers.join(', ')}`;
    }
}

export interface CoverArt {
    /**
     * URL to fetch.
     */
    url: URL;
    /**
     * Artwork types to set. May be empty or undefined.
     */
    types?: ArtworkTypeIDs[];
    /**
     * Comment to set. May be empty or undefined.
     */
    comment?: string;
    /**
     * Whether maximisation should be skipped for this image. If undefined,
     * interpreted as false.
     */
    skipMaximisation?: boolean;
}

export interface ParsedTrackImage {
    url: string;
    trackNumber?: string;
}

export enum ArtworkTypeIDs {
    Back = 2,
    Booklet = 3,
    Front = 1,
    Liner = 12,
    Medium = 4,
    Obi = 5,
    Other = 8,
    Poster = 11,
    Raw = 14,  // Raw/Unedited
    Spine = 6,
    Sticker = 10,
    Track = 7,
    Tray = 9,
    Watermark = 13,
}

export abstract class HeadMetaPropertyProvider extends CoverArtProvider {
    // Providers for which the cover art can be retrieved from the head
    // og:image property and maximised using maxurl

    async findImages(url: URL): Promise<CoverArt[]> {
        // Find an image link from a HTML head meta property, maxurl will
        // maximize it for us. Don't want to use the API because of OAuth.
        const respDocument = parseDOM(await this.fetchPage(url), url.href);
        const coverElmt = qs<HTMLMetaElement>('head > meta[property="og:image"]', respDocument);
        return [{
            url: new URL(coverElmt.content),
            types: [ArtworkTypeIDs.Front],
        }];
    }
}
