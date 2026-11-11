declare module 'ahocorasick' {
  export default class AhoCorasick {
    constructor(keywords: string[])
    search(text: string): Array<[number, string[]]>
  }
}
