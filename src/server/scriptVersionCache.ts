/// <reference path="..\compiler\commandLineParser.ts" />
/// <reference path="..\services\services.ts" />
/// <reference path="session.ts" />

//Note: only real exports are ScriptVersionCache and ILineInfo. Others exported only for unit tests.
namespace ts.server {
    const lineCollectionCapacity = 4;

    //LineNode | LineLeaf
    //must export b/c LineLeaf is exported
    export interface LineCollection {
        charCount(): number; //number of chars, right?
        lineCount(): number; //number of '\n' + 1, right?
        isLeaf(): this is LineLeaf;
        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker): void;
    }

    //These are 1-based line and column.
    export type ILineInfo2 = protocol.Location; //TODO: just use protocol.Location then.

    //this is
    export interface ILineInfo {
        // absolute line number, 0-based.
        line: number;

        //Absolute position in the string. How do I know? `offset: this.root.charCount()`
        //OLD:
        //  Offset relative to start of line. How do I know? scriptInfo.ts `positionToLineOffset` uses `computeLineAndCharacterOfPosition`.
        //  Actually, that's in ILineInfo2 now.
        absolutePosition: number;

        text?: string;
    }

    export interface AbsolutePositionAndLineText {
        absolutePosition: number;
        //Text of the line that `absolutePosition` is on.
        lineText: string | undefined;
    }

    //Must export b/c ILineIndexWalker is exported
    export const enum CharRangeSection {
        PreStart, //?
        Start, //?
        Entire, //?
        Mid, //?
        End, //?
        PostEnd //?
    }

    //either EditWalker, or an object literal in LineIndex.every
    //Must export b/c LineCollection is exported
    export interface ILineIndexWalker {
        goSubtree: boolean; //?
        done: boolean; //?
        leaf(relativeStart: number, relativeLength: number, lineCollection: LineLeaf): void;
        pre?(relativeStart: number, relativeLength: number, lineCollection: LineCollection,
            parent: LineNode, nodeType: CharRangeSection): void; //return value never used!
        post?(relativeStart: number, relativeLength: number, lineCollection: LineCollection,
            parent: LineNode, nodeType: CharRangeSection): void; //return value never used!
    }

    class EditWalker implements ILineIndexWalker {
        goSubtree = true;
        done = false;

        lineIndex = new LineIndex(); //This will be the output?
        // path to start of range
        private startPath: LineCollection[]; //THis must be the path down from the root?
        private endBranch: LineCollection[] = []; //What is this?
        private branchNode: LineNode;
        // path to current node
        private stack: LineNode[];
        private state = CharRangeSection.Entire; //This is only ever Start, End, or Entire
        private lineCollectionAtBranch: LineCollection | undefined;
        private initialText = "";
        private trailingText = "";
        //suppressTrailingText = false; //Don't need an instance variable, just made it a parameter to insertLines

        constructor() {
            this.lineIndex.root = new LineNode();
            this.startPath = [this.lineIndex.root];
            this.stack = [this.lineIndex.root];
        }

        insertLines(insertedText: string, suppressTrailingText: boolean) {
            if (suppressTrailingText) {
                this.trailingText = "";
            }
            if (insertedText) {
                insertedText = this.initialText + insertedText + this.trailingText;
            }
            else {
                insertedText = this.initialText + this.trailingText;
            }
            const { lines } = LineIndex.linesFromText(insertedText);
            if (lines.length > 1) {
                //linesFromText should ensure the below never happens.
                Debug.assert(lines[lines.length - 1] !== "");
                //if (lines[lines.length - 1] === "") {
                //    lines.pop();
                //}
            }
            let branchParent: LineNode;
            let lastZeroCount: LineCollection;

            for (let k = this.endBranch.length - 1; k >= 0; k--) {
                (<LineNode>this.endBranch[k]).updateCounts();
                if (this.endBranch[k].charCount() === 0) {
                    lastZeroCount = this.endBranch[k];
                    if (k > 0) {
                        branchParent = <LineNode>this.endBranch[k - 1];
                    }
                    else {
                        branchParent = this.branchNode;
                    }
                }
            }
            if (lastZeroCount) {
                branchParent.remove(lastZeroCount);
            }

            // path at least length two (root and leaf)
            const leafNode = <LineLeaf>this.startPath[this.startPath.length - 1];

            if (lines.length > 0) {
                leafNode.text = lines[0];

                if (lines.length > 1) {
                    let insertedNodes: LineCollection[] = new Array(lines.length - 1);
                    for (let i = 1; i < lines.length; i++) {
                        insertedNodes[i - 1] = new LineLeaf(lines[i]);
                    }
                    let pathIndex = this.startPath.length - 2;
                    let startNode: LineCollection = leafNode;
                    while (pathIndex >= 0) {
                        const insertionNode = <LineNode>this.startPath[pathIndex];
                        insertedNodes = insertionNode.insertAt(startNode, insertedNodes);
                        pathIndex--;
                        startNode = insertionNode;
                    }
                    let insertedNodesLen = insertedNodes.length;
                    while (insertedNodesLen > 0) {
                        const newRoot = new LineNode();
                        newRoot.add(this.lineIndex.root);
                        insertedNodes = newRoot.insertAt(this.lineIndex.root, insertedNodes);
                        insertedNodesLen = insertedNodes.length;
                        this.lineIndex.root = newRoot;
                    }
                    this.lineIndex.root.updateCounts();
                }
                else {
                    for (let j = this.startPath.length - 2; j >= 0; j--) {
                        (<LineNode>this.startPath[j]).updateCounts();
                    }
                }
            }
            else {
                const insertionNode = <LineNode>this.startPath[this.startPath.length - 2];
                // no content for leaf node, so delete it
                insertionNode.remove(leafNode);
                for (let j = this.startPath.length - 2; j >= 0; j--) {
                    (<LineNode>this.startPath[j]).updateCounts();
                }
            }

            return this.lineIndex;
        }

        post(_relativeStart: number, _relativeLength: number, lineCollection: LineCollection): void {
            // have visited the path for start of range, now looking for end
            // if range is on single line, we will never make this state transition
            if (lineCollection === this.lineCollectionAtBranch) {
                this.state = CharRangeSection.End;
            }
            // always pop stack because post only called when child has been visited
            this.stack.pop();
            //return undefined; //return value never used
        }

        pre(_relativeStart: number, _relativeLength: number, lineCollection: LineCollection, _parent: LineCollection, nodeType: CharRangeSection): void {
            // currentNode corresponds to parent, but in the new tree
            const currentNode = this.stack[this.stack.length - 1];

            if ((this.state === CharRangeSection.Entire) && (nodeType === CharRangeSection.Start)) {
                // if range is on single line, we will never make this state transition
                this.state = CharRangeSection.Start;
                this.branchNode = currentNode;
                this.lineCollectionAtBranch = lineCollection;
            }

            let child: LineCollection;
            function fresh(node: LineCollection): LineCollection {
                if (node.isLeaf()) {
                    return new LineLeaf("");
                }
                else return new LineNode();
            }
            switch (nodeType) {
                case CharRangeSection.PreStart:
                    this.goSubtree = false;
                    if (this.state !== CharRangeSection.End) {
                        currentNode.add(lineCollection);
                    }
                    break;
                case CharRangeSection.Start:
                    if (this.state === CharRangeSection.End) {
                        this.goSubtree = false;
                    }
                    else {
                        child = fresh(lineCollection);
                        currentNode.add(child);
                        this.startPath.push(child);
                    }
                    break;
                case CharRangeSection.Entire:
                    if (this.state !== CharRangeSection.End) {
                        child = fresh(lineCollection);
                        currentNode.add(child);
                        this.startPath.push(child);
                    }
                    else {
                        if (!lineCollection.isLeaf()) {
                            child = fresh(lineCollection);
                            currentNode.add(child);
                            this.endBranch.push(child);
                        }
                    }
                    break;
                case CharRangeSection.Mid:
                    this.goSubtree = false;
                    break;
                case CharRangeSection.End:
                    if (this.state !== CharRangeSection.End) {
                        this.goSubtree = false;
                    }
                    else {
                        if (!lineCollection.isLeaf()) {
                            child = fresh(lineCollection);
                            currentNode.add(child);
                            this.endBranch.push(child);
                        }
                    }
                    break;
                case CharRangeSection.PostEnd:
                    this.goSubtree = false;
                    if (this.state !== CharRangeSection.Start) {
                        currentNode.add(lineCollection);
                    }
                    break;
            }
            if (this.goSubtree) {
                this.stack.push(<LineNode>child);
            }
            //return lineCollection; //return value never used!
        }
        // just gather text from the leaves
        leaf(relativeStart: number, relativeLength: number, ll: LineLeaf) {
            if (this.state === CharRangeSection.Start) {
                this.initialText = ll.text.substring(0, relativeStart);
            }
            else if (this.state === CharRangeSection.Entire) {
                this.initialText = ll.text.substring(0, relativeStart);
                this.trailingText = ll.text.substring(relativeStart + relativeLength);
            }
            else {
                //state is CharRangeSection.End (todo: assert, or use a different type!)
                this.trailingText = ll.text.substring(relativeStart + relativeLength);
            }
        }
    }

    // text change information
    //Must export b/c LineIndexSnapshot is exported
    export class TextChange {
        constructor(public pos: number, public deleteLen: number, public insertedText: string) {
        }

        getTextChangeRange() {
            return ts.createTextChangeRange(ts.createTextSpan(this.pos, this.deleteLen),
                this.insertedText ? this.insertedText.length : 0);
        }
    }

    //This is the main export of this file. Others are only exported for sake of unit tests
    export class ScriptVersionCache {
        private changes: TextChange[] = [];
        private versions: LineIndexSnapshot[] = new Array<LineIndexSnapshot>(ScriptVersionCache.maxVersions);
        private minVersion = 0;  // no versions earlier than min version will maintain change history

        private host: FileReader;
        private currentVersion = 0;

        private static changeNumberThreshold = 8;
        private static changeLengthThreshold = 256;
        private static maxVersions = 8;

        private versionToIndex(version: number) {
            if (version < this.minVersion || version > this.currentVersion) {
                Debug.fail();//return undefined;
            }
            return version % ScriptVersionCache.maxVersions;
        }

        private currentVersionToIndex() {
            return this.currentVersion % ScriptVersionCache.maxVersions;
        }

        // REVIEW: can optimize by coalescing simple edits
        //this still needs review...
        edit(pos: number, deleteLen: number, insertedText: string) {
            this.changes.push(new TextChange(pos, deleteLen, insertedText));
            if (this.changes.length > ScriptVersionCache.changeNumberThreshold ||
                deleteLen > ScriptVersionCache.changeLengthThreshold ||
                insertedText && insertedText.length > ScriptVersionCache.changeLengthThreshold) {
                this.getSnapshot();
            }
        }

        latest() {
            return this.versions[this.currentVersionToIndex()];
        }

        latestVersion() {
            if (this.changes.length > 0) {
                this.getSnapshot();
            }
            return this.currentVersion;
        }

        reloadFromFile(filename: string) {
            let content = this.host.readFile(filename);
            // If the file doesn't exist or cannot be read, we should
            // wipe out its cached content on the server to avoid side effects.
            if (!content) {
                content = "";
            }
            this.reload(content);
        }

        // reload whole script, leaving no change history behind reload
        reload(script: string) {
            this.currentVersion++;
            this.changes = []; // history wiped out by reload
            const snap = new LineIndexSnapshot(this.currentVersion, this);

            // delete all versions
            for (let i = 0; i < this.versions.length; i++) {
                this.versions[i] = undefined;
            }

            this.versions[this.currentVersionToIndex()] = snap;
            snap.index = new LineIndex();
            const lm = LineIndex.linesFromText(script);
            snap.index.load(lm.lines);

            this.minVersion = this.currentVersion;
        }

        getSnapshot(): IScriptSnapshot & { readonly version: number, readonly index: LineIndex } {
            let snap = this.versions[this.currentVersionToIndex()];
            if (this.changes.length > 0) {
                let snapIndex = snap.index;
                for (const change of this.changes) {
                    snapIndex = snapIndex.edit(change.pos, change.deleteLen, change.insertedText);
                }
                snap = new LineIndexSnapshot(this.currentVersion + 1, this);
                snap.index = snapIndex;
                snap.changesSincePreviousVersion = this.changes;

                this.currentVersion = snap.version;
                this.versions[this.currentVersionToIndex()] = snap;
                this.changes = [];

                if ((this.currentVersion - this.minVersion) >= ScriptVersionCache.maxVersions) {
                    this.minVersion = (this.currentVersion - ScriptVersionCache.maxVersions) + 1;
                }
            }
            return snap;
        }

        getTextChangesBetweenVersions(oldVersion: number, newVersion: number): TextChangeRange {
            if (oldVersion < newVersion) {
                if (oldVersion >= this.minVersion) {
                    const textChangeRanges: ts.TextChangeRange[] = [];
                    for (let i = oldVersion + 1; i <= newVersion; i++) {
                        const snap = this.versions[this.versionToIndex(i)];
                        for (const textChange of snap.changesSincePreviousVersion) {
                            textChangeRanges.push(textChange.getTextChangeRange());
                        }
                    }
                    return ts.collapseTextChangeRangesAcrossMultipleVersions(textChangeRanges);
                }
                else {
                    Debug.fail("?");
                    //return undefined;
                }
            }
            else {
                Debug.fail("?");
                //return ts.unchangedTextChangeRange;
            }
        }

        static fromString(host: FileReader, script: string): ScriptVersionCache {
            const svc = new ScriptVersionCache();
            const snap = new LineIndexSnapshot(0, svc);
            svc.versions[svc.currentVersion] = snap;
            svc.host = host;
            snap.index = new LineIndex();
            const lm = LineIndex.linesFromText(script);
            snap.index.load(lm.lines);
            return svc;
        }
    }

    //TODO: don't export
    export class LineIndexSnapshot implements IScriptSnapshot {
        index: LineIndex; //mutable!
        changesSincePreviousVersion: TextChange[] = [];

        constructor(readonly version: number, readonly cache: { getTextChangesBetweenVersions(oldVersion: number, newVersion: number): TextChangeRange; }) {
        }

        getText(rangeStart: number, rangeEnd: number) {
            return this.index.getText(rangeStart, rangeEnd - rangeStart);
        }

        getLength() {
            return this.index.root.charCount();
        }

        private getTextChangeRangeSinceVersion(scriptVersion: number) {
            if (this.version <= scriptVersion) {
                return ts.unchangedTextChangeRange;
            }
            else {
                return this.cache.getTextChangesBetweenVersions(scriptVersion, this.version);
            }
        }
        getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
            if (oldSnapshot instanceof LineIndexSnapshot && this.cache === oldSnapshot.cache) {
                return this.getTextChangeRangeSinceVersion(oldSnapshot.version);
            }
        }
    }

    //This is exported! should probably be under an interface
    export class LineIndex {
        root: LineNode;
        // set this to true to check each edit for accuracy
        checkEdits = true;//false;

        charOffsetToLineNumberAndPos(position: number): ILineInfo2 { //rename: positionToLineAndColumn
            const { zeroBasedLine, zeroBasedColumn } = this.root.charOffsetToLineNumberAndPos(0, position);
            return { line: zeroBasedLine + 1, offset: zeroBasedColumn + 1 };
        }

        positionToColumnAndLineText(position: number): { zeroBasedColumn: number, lineText?: string } {
            return this.root.charOffsetToLineNumberAndPos(0, position);
        }

        //! PRobably shouldn't include `line` in the output here...
        //Output offset is a *total* offset.
        //rename
        //input line number is 1-based
        lineNumberToInfo(lineNumber: number): AbsolutePositionAndLineText {
            const lineCount = this.root.lineCount();
            if (lineNumber <= lineCount) {
                const { position, leaf } = this.root.lineNumberToInfo(lineNumber, /*positionAcc*/ 0);
                return {
                    absolutePosition: position, //it's the root, so position is absolute
                    lineText: leaf && leaf.text,
                };
            }
            else {
                Debug.assert(lineNumber === lineCount + 1); //This fails in unit tests in versionCache.ts "TS code change 19 1 1 0" and "TS code change 18 1 1 0"
                return {
                    absolutePosition: this.root.charCount(),
                    lineText: undefined,
                };
            }
        }

        load(lines: string[]): void {
            if (lines.length > 0) {
                const leaves: LineLeaf[] = [];
                for (let i = 0; i < lines.length; i++) {
                    leaves[i] = new LineLeaf(lines[i]);
                }
                this.root = LineIndex.buildTreeFromBottom(leaves);
            }
            else {
                this.root = new LineNode();
            }
        }

        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
            this.root.walk(rangeStart, rangeLength, walkFns);
        }

        getText(rangeStart: number, rangeLength: number) {
            let accum = "";
            if ((rangeLength > 0) && (rangeStart < this.root.charCount())) {
                this.walk(rangeStart, rangeLength, {
                    goSubtree: true,
                    done: false,
                    leaf: (relativeStart: number, relativeLength: number, ll: LineLeaf) => {
                        accum += ll.text.substring(relativeStart, relativeStart + relativeLength);
                    }
                });
            }
            return accum;
        }

        getLength(): number {
            return this.root.charCount();
        }

        every(f: (ll: LineLeaf, s: number, len: number) => boolean, rangeStart: number, rangeEnd?: number) {
            if (!rangeEnd) {
                rangeEnd = this.root.charCount();
            }
            const walkFns: ILineIndexWalker = {
                goSubtree: true,
                done: false,
                leaf(relativeStart: number, relativeLength: number, ll: LineLeaf) {
                    if (!f(ll, relativeStart, relativeLength)) {
                        this.done = true;
                    }
                }
            };
            this.walk(rangeStart, rangeEnd - rangeStart, walkFns);
            return !walkFns.done;
        }

        //This doesn't mutate this lineIndex, it creates a new one.
        edit(pos: number, deleteLength: number, newText: string): LineIndex { //This one actually does it.
            function editFlat(source: string, start: number, deleteLen: number, insertString: string) {
                return source.substring(0, start) + insertString + source.substring(start + deleteLen, source.length);
            }
            if (this.root.charCount() === 0) {
                // TODO: assert deleteLength === 0
                Debug.assert(newText !== undefined);
                //if (newText !== undefined) {
                    this.load(LineIndex.linesFromText(newText).lines);
                    return this;
                //}
            }
            else {
                let checkText: string;
                if (this.checkEdits) {
                    checkText = editFlat(this.getText(0, this.root.charCount()), pos, deleteLength, newText);
                }
                const walker = new EditWalker();
                let suppressTrailingText = false;
                if (pos >= this.root.charCount()) {
                    // insert at end
                    pos = this.root.charCount() - 1; //TODO: assert this?
                    const endString = this.getText(pos, 1);
                    if (newText) { //shouldn't be necessary to test
                        newText = endString + newText;
                    }
                    else {
                        newText = endString;
                    }
                    deleteLength = 0;
                    suppressTrailingText = true;
                }
                else if (deleteLength > 0) {
                    // check whether last characters deleted are line break
                    const { zeroBasedColumn, lineText } = this.positionToColumnAndLineText(pos + deleteLength);
                    if (zeroBasedColumn === 0) {
                        // move range end just past line that will merge with previous line
                        deleteLength += lineText.length;
                        // store text by appending to end of insertedText
                        newText = newText !== undefined ? newText + lineText : newText;
                    }
                }
                Debug.assert(pos < this.root.charCount());
                //if (pos < this.root.charCount()) {//This will always be true! Because we check for `pos >= this.root.charCount()` and change it!
                this.root.walk(pos, deleteLength, walker);
                walker.insertLines(newText, suppressTrailingText);
                //}

                if (this.checkEdits) {
                    //`this.getText` didn't change, walker created a *new* node with updated text.
                    const updatedText = walker.lineIndex.getText(0, walker.lineIndex.getLength());//this.getText(0, this.root.charCount());
                    Debug.assert(checkText === updatedText, "buffer edit mismatch");
                }
                return walker.lineIndex;
            }
        }

        private static buildTreeFromBottom(nodes: LineCollection[]): LineNode {
            const interiorNodeCount = Math.ceil(nodes.length / lineCollectionCapacity);
            const interiorNodes: LineNode[] = new Array(interiorNodeCount);
            let nodeIndex = 0;
            for (let i = 0; i < interiorNodeCount; i++) {
                const interiorNode = interiorNodes[i] = new LineNode();
                let charCount = 0;
                let lineCount = 0;
                for (let j = 0; j < lineCollectionCapacity; j++) {
                    if (nodeIndex >= nodes.length)
                        break;

                    const node = nodes[nodeIndex];
                    interiorNode.add(node);
                    //Todo: why doesn't `add` update totalchars?
                    charCount += node.charCount();
                    lineCount += node.lineCount();
                    nodeIndex++;
                }
                interiorNode.totalChars = charCount;
                interiorNode.totalLines = lineCount;
            }
            if (interiorNodes.length === 1) {
                return interiorNodes[0];
            }
            else {
                return this.buildTreeFromBottom(interiorNodes);
            }
        }

        //text -> array of lines
        //note that lineMap may have one more entry than lines if the last line is empty (and doesn't end in "\n")
        static linesFromText(text: string) {
            const lineStarts = ts.computeLineStarts(text);

            if (lineStarts.length === 0) {
                throw new Error("Pretty sure this is impossible. Always at least 1 line.");
                //return { lines: <string[]>[], lineMap: lineStarts };
            }
            const lines = <string[]>new Array(lineStarts.length);
            const lastLineIndex = lineStarts.length - 1;
            for (let i = 0; i < lastLineIndex; i++) {
                lines[i] = text.substring(lineStarts[i], lineStarts[i + 1]);
            }

            const endText = text.substring(lineStarts[lastLineIndex]);
            if (endText.length > 0) {
                lines[lastLineIndex] = endText;
            }
            else {
                lines.pop();
            }
            return { lines, lineMap: lineStarts };
        }
    }

    //Must export b/c ILineIndexWalker is exported
    export class LineNode implements LineCollection {
        totalChars = 0;
        totalLines = 0;
        private children: LineCollection[] = [];

        isLeaf() {
            return false;
        }

        updateCounts() {
            this.totalChars = 0;
            this.totalLines = 0;
            for (const child of this.children) {
                this.totalChars += child.charCount();
                this.totalLines += child.lineCount();
            }
        }

        private execWalk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker, childIndex: number, nodeType: CharRangeSection) {
            if (walkFns.pre) {
                walkFns.pre(rangeStart, rangeLength, this.children[childIndex], this, nodeType);
            }
            if (walkFns.goSubtree) {
                this.children[childIndex].walk(rangeStart, rangeLength, walkFns);
                if (walkFns.post) {
                    walkFns.post(rangeStart, rangeLength, this.children[childIndex], this, nodeType);
                }
            }
            else {
                walkFns.goSubtree = true;
            }
            return walkFns.done;
        }

        private skipChild(relativeStart: number, relativeLength: number, childIndex: number, walkFns: ILineIndexWalker, nodeType: CharRangeSection) {
            if (walkFns.pre && (!walkFns.done)) {
                walkFns.pre(relativeStart, relativeLength, this.children[childIndex], this, nodeType);
                walkFns.goSubtree = true;
            }
        }

        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
            // assume (rangeStart < this.totalChars) && (rangeLength <= this.totalChars)
            let childIndex = 0;
            let childCharCount = this.children[childIndex].charCount();
            // find sub-tree containing start
            let adjustedStart = rangeStart; //This will be the start relative to the child we end up in. TODO: factor out calculation of adjustedStart
            while (adjustedStart >= childCharCount) {
                this.skipChild(adjustedStart, rangeLength, childIndex, walkFns, CharRangeSection.PreStart);
                adjustedStart -= childCharCount;
                childIndex++;
                childCharCount = this.children[childIndex].charCount();
            }
            // Case I: both start and end of range in same subtree
            if ((adjustedStart + rangeLength) <= childCharCount) {
                if (this.execWalk(adjustedStart, rangeLength, walkFns, childIndex, CharRangeSection.Entire)) {
                    return;
                }
            }
            else {
                // Case II: start and end of range in different subtrees (possibly with subtrees in the middle)
                if (this.execWalk(adjustedStart, childCharCount - adjustedStart, walkFns, childIndex, CharRangeSection.Start)) {
                    return;
                }
                let adjustedLength = rangeLength - (childCharCount - adjustedStart);
                childIndex++;
                const child = this.children[childIndex];
                childCharCount = child.charCount();
                while (adjustedLength > childCharCount) {
                    if (this.execWalk(0, childCharCount, walkFns, childIndex, CharRangeSection.Mid)) {
                        return;
                    }
                    adjustedLength -= childCharCount;
                    childIndex++;
                    const child = this.children[childIndex];
                    childCharCount = child.charCount();
                }
                if (adjustedLength > 0) {
                    if (this.execWalk(0, adjustedLength, walkFns, childIndex, CharRangeSection.End)) {
                        return;
                    }
                }
            }
            // Process any subtrees after the one containing range end
            if (walkFns.pre) {
                const clen = this.children.length;
                if (childIndex < (clen - 1)) {
                    for (let ej = childIndex + 1; ej < clen; ej++) { //rename ej
                        this.skipChild(0, 0, ej, walkFns, CharRangeSection.PostEnd);
                    }
                }
            }
        }

        //input lineNumber is the running total of the line number for the given offset.
        //input charOffset is relative to the start of this node.
        //output line is the absolute line number.
        //Note that in lineNumberToInfo we *start* knowing the line and must determine the total offset; here we start knowing the total offset and must determine the line number.
        charOffsetToLineNumberAndPos(lineNumberAcc: number, position: number): { zeroBasedLine: number, zeroBasedColumn: number, lineText?: string } {
            const childInfo = this.childFromCharOffset(lineNumberAcc, position); //inline
            if (!childInfo.child) {
                Debug.assert(this.children.length === 0); //neater: just check for this first.
                Debug.fail(); //LineNode should always have children, right?
                return {
                    zeroBasedLine: lineNumberAcc,
                    zeroBasedColumn: position,
                };
            }
            else if (childInfo.childIndex < this.children.length) {
                if (childInfo.child.isLeaf()) {
                    return {
                        zeroBasedLine: childInfo.lineNumberAcc,
                        zeroBasedColumn: childInfo.relPosition,
                        lineText: childInfo.child.text,
                    };
                }
                else {
                    const lineNode = <LineNode>(childInfo.child);
                    return lineNode.charOffsetToLineNumberAndPos(childInfo.lineNumberAcc, childInfo.relPosition);
                }
            }
            else {
                //childInfo.child set to the last child, ignore it.
                //get last LineLeaf and return position at the end of it
                const { leaf } = this.lineNumberToInfo(this.lineCount(), /*positionAcc*/ 0); //only used for the leaf, make neater. Also will crash if leaf missing
                return { zeroBasedLine: this.lineCount(), zeroBasedColumn: leaf.charCount() };
            }
        }

        //Input lineNumber is 1-based, relative to start of this node.
        //Input charOffset is a *running total* of the absolute position.
        //Output lineNumber is... overwritten, wtf
        //Ouptut offset is the final *total* charOffset
        lineNumberToInfo(lineNumber: number, positionAcc: number): { position: number, leaf?: LineLeaf } {
            const childInfo = this.childFromLineNumber(lineNumber, positionAcc); //maybe inline this function.
            if (!childInfo.child) {
                Debug.fail(); //Should always have at least 1 child, right?
                return { position: positionAcc };
            }
            else if (childInfo.child.isLeaf()) {
                return {
                    position: childInfo.positionAcc,
                    leaf: childInfo.child,
                };
            }
            else {
                const lineNode = <LineNode>(childInfo.child);
                return lineNode.lineNumberToInfo(childInfo.relativeLineNumber, childInfo.positionAcc);
            }
        }

        /*
        Input lineNumber is a line offset *relative* to the start line of this node.
        Output relativeLineNumber is relative to the *child*, while input is relative to *this*.
        Input charOffset is the *running* total position. This will be absolute once lineNumber reaches 0.
        So given:

            abc A
                    X
            def B
                        Z
            ghi C
                    Y
            jkl D

            mno E

            pqr F


        Say we are looking for line 3, char 1. ('k')
        We will skip past `X` and translate that to line 1, char 7.
        Then we will skip past `C` and translate that to line 0, char 10.
        Right???
        */
        private childFromLineNumber(lineNumber: number, positionAcc: number) {
            let child: LineCollection;
            let relativeLineNumber = lineNumber;
            let i: number;
            for (i = 0; i < this.children.length; i++) {
                child = this.children[i];
                const childLineCount = child.lineCount();
                if (childLineCount >= relativeLineNumber) { //This is because lineNumber is 1-based!!!
                    break;
                }
                else {
                    relativeLineNumber -= childLineCount;
                    positionAcc += child.charCount();
                }
            }
            return {
                child,
                relativeLineNumber,
                positionAcc,
            };
        }

        //input relPosition is offset into *this* node. output relPosition is offset into *child*.
        //input lineNumberAcc is number of lines passed so far. output is new number of lines passed.
        //Note: this loop decreases charOffset until it's less than child.charCount(). So, it ends up as a position inside `child`.
        private childFromCharOffset(lineNumberAcc: number, relPosition: number) {
            let child: LineCollection;
            let i: number;
            let len: number;
            for (i = 0, len = this.children.length; i < len; i++) {
                child = this.children[i];
                if (child.charCount() > relPosition) {
                    break;
                }
                else {
                    relPosition -= child.charCount();
                    lineNumberAcc += child.lineCount();
                }
            }
            return {
                child,
                childIndex: i,
                relPosition,
                lineNumberAcc,
            };
        }

        private splitAfter(childIndex: number) {
            let splitNode: LineNode;
            const clen = this.children.length;
            childIndex++;
            const endLength = childIndex;
            if (childIndex < clen) {
                splitNode = new LineNode();
                while (childIndex < clen) {
                    splitNode.add(this.children[childIndex]);
                    childIndex++;
                }
                splitNode.updateCounts();
            }
            this.children.length = endLength;
            return splitNode;
        }

        remove(child: LineCollection) {
            const childIndex = this.findChildIndex(child);
            const clen = this.children.length;
            if (childIndex < (clen - 1)) {
                for (let i = childIndex; i < (clen - 1); i++) {
                    this.children[i] = this.children[i + 1];
                }
            }
            this.children.pop();
        }

        private findChildIndex(child: LineCollection) { //just use indexOf, and assert that it's never -1
            let childIndex = 0;
            const clen = this.children.length;
            while ((this.children[childIndex] !== child) && (childIndex < clen)) childIndex++;
            return childIndex;
        }

        insertAt(child: LineCollection, nodes: LineCollection[]) {
            let childIndex = this.findChildIndex(child);
            const clen = this.children.length;
            const nodeCount = nodes.length;
            // if child is last and there is more room and only one node to place, place it
            if ((clen < lineCollectionCapacity) && (childIndex === (clen - 1)) && (nodeCount === 1)) {
                this.add(nodes[0]);
                this.updateCounts();
                return [];
            }
            else {
                const shiftNode = this.splitAfter(childIndex);
                let nodeIndex = 0;
                childIndex++;
                while ((childIndex < lineCollectionCapacity) && (nodeIndex < nodeCount)) {
                    this.children[childIndex] = nodes[nodeIndex];
                    childIndex++;
                    nodeIndex++;
                }
                let splitNodes: LineNode[] = [];
                let splitNodeCount = 0;
                if (nodeIndex < nodeCount) {
                    splitNodeCount = Math.ceil((nodeCount - nodeIndex) / lineCollectionCapacity);
                    splitNodes = <LineNode[]>new Array(splitNodeCount);
                    let splitNodeIndex = 0;
                    for (let i = 0; i < splitNodeCount; i++) {
                        splitNodes[i] = new LineNode();
                    }
                    let splitNode = <LineNode>splitNodes[0];
                    while (nodeIndex < nodeCount) {
                        splitNode.add(nodes[nodeIndex]);
                        nodeIndex++;
                        if (splitNode.children.length === lineCollectionCapacity) {
                            splitNodeIndex++;
                            splitNode = <LineNode>splitNodes[splitNodeIndex];
                        }
                    }
                    for (let i = splitNodes.length - 1; i >= 0; i--) {
                        if (splitNodes[i].children.length === 0) {
                            splitNodes.pop();
                        }
                    }
                }
                if (shiftNode) {
                    splitNodes.push(shiftNode);
                }
                this.updateCounts();
                for (let i = 0; i < splitNodeCount; i++) {
                    (<LineNode>splitNodes[i]).updateCounts();
                }
                return splitNodes;
            }
        }

        // assume there is room for the item; return true if more room
        add(collection: LineCollection) {
            this.children.push(collection);
            Debug.assert(this.children.length <= lineCollectionCapacity);
            //return value never used!
            //return (this.children.length < lineCollectionCapacity);
        }

        charCount() {
            return this.totalChars;
        }

        lineCount() {
            return this.totalLines;
        }
    }

    //This is exported! Probably shouldn't be
    export class LineLeaf implements LineCollection {
        constructor(public text: string) {
        }

        isLeaf() {
            return true;
        }

        walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
            walkFns.leaf(rangeStart, rangeLength, this);
        }

        charCount() {
            return this.text.length;
        }

        lineCount() {
            return 1;
        }
    }
}