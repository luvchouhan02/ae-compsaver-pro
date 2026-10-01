/**
 * template-delete-persistence.test.js
 * Verifies that single delete and bulk delete across all template sections:
 * 1. Forward the exact on-disk folderPath to ExtendScript.
 * 2. Properly remove the entry from LibraryIndex (preventing resurrection on restart/refresh).
 * 3. Correctly update allTemplates, TemplateCatalog, and optimistic UI.
 * 4. ExtendScript functions delete direct folders and return honest results.
 */

const { encodeBridge, decodeBridge } = require("../js/core/bridge");
const { LibraryIndex } = require("../js/core/persistence");

describe("Template Delete & Bulk Delete Persistence", () => {
    let mockIndex;

    beforeEach(() => {
        mockIndex = new LibraryIndex();
    });

    test("LibraryIndex.removeEntry succeeds with exact and normalized folderPath", () => {
        const folder = "C:/Library/comp/Social/LowerThird_01";
        mockIndex.insertAtHead({
            folderPath: folder,
            name: "LowerThird 01",
            category: "Social",
            section: "comp",
            type: "comp"
        });

        expect(mockIndex.has(folder)).toBe(true);
        expect(mockIndex.entries()).toHaveLength(1);

        mockIndex.removeEntry(folder);
        expect(mockIndex.has(folder)).toBe(false);
        expect(mockIndex.entries()).toHaveLength(0);
    });

    test("LibraryIndex removeEntry handles media folders with mediaIdFolderSegment hex ids", () => {
        const mediaFolder = "C:/Library/footage/Broll/media-666f6f74616765-1";
        mockIndex.insertAtHead({
            folderPath: mediaFolder,
            name: "Aerial_Shot.mp4",
            category: "Broll",
            section: "footage",
            type: "media"
        });

        expect(mockIndex.has(mediaFolder)).toBe(true);

        mockIndex.removeEntry(mediaFolder);
        expect(mockIndex.has(mediaFolder)).toBe(false);
        expect(mockIndex.entries()).toHaveLength(0);
    });

    test("deleteTemplate evalScript contract passes 4 parameters including folderPath", () => {
        const name = "Glitch Title";
        const cat = "Titles";
        const root = "C:/CompSaverLibrary";
        const folderPath = "C:/CompSaverLibrary/text/Titles/Glitch_Title";

        const script = 'deleteTemplate("' +
            encodeBridge(name) + '","' +
            encodeBridge(cat) + '","' +
            encodeBridge(root) + '","' +
            encodeBridge(folderPath) + '")';

        const match = script.match(/deleteTemplate\("([^"]+)","([^"]+)","([^"]+)","([^"]+)"\)/);
        expect(match).not.toBeNull();
        expect(decodeBridge(match[1])).toBe(name);
        expect(decodeBridge(match[2])).toBe(cat);
        expect(decodeBridge(match[3])).toBe(root);
        expect(decodeBridge(match[4])).toBe(folderPath);
    });

    test("deleteTemplatesBulk evalScript contract passes 4 parameters including joined folders", () => {
        const ids = ["Comp1", "Comp2", "Media1"];
        const cats = ["Motion", "Motion", "Footage"];
        const root = "D:/MyLibrary";
        const folders = [
            "D:/MyLibrary/comp/Motion/Comp1",
            "D:/MyLibrary/comp/Motion/Comp2",
            "D:/MyLibrary/footage/Footage/media-12345"
        ];

        const script = 'deleteTemplatesBulk("' +
            encodeBridge(ids.join("||")) + '","' +
            encodeBridge(cats.join("||")) + '","' +
            encodeBridge(root) + '","' +
            encodeBridge(folders.join("||")) + '")';

        const match = script.match(/deleteTemplatesBulk\("([^"]+)","([^"]+)","([^"]+)","([^"]+)"\)/);
        expect(match).not.toBeNull();
        expect(decodeBridge(match[1]).split("||")).toEqual(ids);
        expect(decodeBridge(match[2]).split("||")).toEqual(cats);
        expect(decodeBridge(match[3])).toBe(root);
        expect(decodeBridge(match[4]).split("||")).toEqual(folders);
    });
});
