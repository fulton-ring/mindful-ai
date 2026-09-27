/**
 * Stand-in for the `cloudflare` REST SDK (~8 MB bundled). @mastra/cloudflare-d1
 * imports it only to construct a client for its REST (apiToken) mode; Walden
 * always passes the D1 Workers binding, so the SDK is never constructed.
 */
export default class Cloudflare {
  constructor() {
    throw new Error('The Cloudflare REST SDK is not bundled; use the D1 binding.');
  }
}
