# Requirements Document

## Introduction

This feature repairs two connected icon-import failures. A file or folder selection must add supported media to the catalog without modifying the After Effects timeline. A later action on a completed icon card must place the selected icon in the active composition. Folder imports must retain successful items when other items fail, remove failed provisional state, and report exact results.

The requirements focus on the durability boundary shared by both failures: a card may appear progressively while ingestion is pending, but a card must not behave like a normal timeline-import action until the destination folder, main file, and catalog record are durable. The feature preserves recursive discovery, progressive item completion, card-derived section routing, path sanitization, catalog ordering, and established media-card lifecycle behavior.

## Glossary

- **Catalog**: The persisted and in-memory collection of media records rendered as cards.
- **Catalog_Record**: The persisted and in-memory metadata entry for one catalog item.
- **Catalog_Index**: The durable store used to reconstruct Catalog_Records after the panel reopens.
- **Preexisting_Catalog_Record**: A Catalog_Record created before this feature and lacking the Pending_State marker introduced by this feature.
- **Catalog_Card**: The visual catalog representation of one Catalog_Record.
- **Card_ID**: The stable identifier shared by a Catalog_Record and the corresponding Catalog_Card.
- **Active_Composition**: The After Effects composition active when a catalog card action occurs.
- **Timeline**: The layer collection of the Active_Composition.
- **Timeline_Layer**: A layer in the Timeline whose source references selected icon media.
- **File_Picker**: The catalog import control that returns one selected file.
- **Folder_Picker**: The catalog import control that returns one selected directory.
- **Picker_Import**: A catalog ingestion operation started by the File_Picker or Folder_Picker.
- **Bulk_Import**: A Picker_Import that processes the Import_Candidates discovered under one selected folder.
- **Supported_Media_File**: A regular file whose extension is accepted by the existing supported-media registry for the selected catalog section.
- **Unsupported_File**: A discovered file that is not a Supported_Media_File.
- **Discovery_Limits**: The configured maximum traversal depth, file count, and directory count applied by recursive media discovery before this feature.
- **Source_Identity**: The canonicalized source path used by existing deduplication rules to identify one source file.
- **Discovery_Baseline**: The Supported_Media_File registry, Discovery_Limits, and Source_Identity deduplication behavior in effect before this feature.
- **Import_Candidate**: One unique Supported_Media_File accepted for ingestion after Source_Identity deduplication.
- **Item_Name**: The display name derived from the source filename without the filename extension.
- **Category_Name**: The user-selected category or selected folder name used to categorize an imported item.
- **Backing_Destination**: The library directory stored in the Catalog_Record for an imported item.
- **Main_File**: The copied media file inside the Backing_Destination that the host imports into After Effects.
- **Required_Durability_Stage**: Creation of the Backing_Destination, successful completion of the Main_File copy, or successful persistence of the Catalog_Record in the Catalog_Index.
- **Durability_Gate**: The verifiable condition in which the Backing_Destination exists as a directory, the Main_File exists as a readable regular file after a successful copy, and the Catalog_Index has acknowledged persistence of the Catalog_Record with the final Backing_Destination and Main_File values.
- **Pending_State**: The item state before the Durability_Gate is satisfied.
- **Ready_State**: The item state after the Durability_Gate is satisfied.
- **Normal_Card_Action**: The established click or import action used to place a catalog item in the Active_Composition.
- **Pending_Card**: A Catalog_Card that visibly represents Pending_State and does not expose the Normal_Card_Action.
- **Ready_Card**: A Catalog_Card that represents Ready_State and exposes the Normal_Card_Action.
- **Stored_Folder_Path**: The normalized Backing_Destination path stored on the Catalog_Record and Catalog_Card.
- **Card_Derived_Section**: The canonical catalog section resolved from the selected Catalog_Record or Catalog_Card rather than from global navigation state.
- **Timeline_Import_Request**: One request from the panel import engine to the host batch-import entry point for a selected Catalog_Record.
- **Path_Sanitization**: The deterministic conversion of category names, item names, identifiers, separators, and reserved path characters into library path segments.
- **Path_Sanitization_Baseline**: The Path_Sanitization input-output behavior captured before this feature by the existing path regression tests.
- **Thumbnail_Generation**: The nonessential item stage that creates a card preview after the Main_File copy; Thumbnail_Generation does not determine Main_File durability.
- **Placeholder_Visual**: The standard empty-thumbnail artwork rendered when no completed thumbnail is available.
- **Thumbnail_Failure_Visual**: The established failed-thumbnail badge or failed-thumbnail card state rendered when Thumbnail_Generation fails.
- **Successful_Item**: An Import_Candidate that satisfies the Durability_Gate and reaches Ready_State.
- **Failed_Item**: An Import_Candidate that reaches a terminal failure before satisfying the Durability_Gate.
- **Owned_Partial_Artifact**: A file or directory created by the current import operation for one Import_Candidate and not present before the import operation.
- **Catalog_Order**: The relative position assigned to each Catalog_Card when Import_Candidates are inserted.
- **Full_Filesystem_Rescan**: A traversal of the library filesystem used to rebuild the complete Catalog.
- **Partial_Success_Status**: The Bulk_Import terminal status used when at least one Import_Candidate is a Successful_Item and at least one Import_Candidate is a Failed_Item.
- **Operation_Level_Failure**: A Picker_Import failure that occurs before any Import_Candidate is created.
- **Actionable_Reason**: A failure explanation that identifies the affected Item_Name when an item exists or identifies the affected Picker_Import when no item exists, identifies the failing stage or missing artifact, and states a corrective action available to the user.
- **Bulk_Import_Summary**: The terminal user feedback for one Bulk_Import, produced after all Import_Candidates and required cleanup operations settle.
- **Icon_Import_System**: The complete panel and host behavior that ingests icon media into the Catalog and later places selected icon media in an Active_Composition.
- **Catalog_Ingestion_System**: The part of the Icon_Import_System that copies Import_Candidates into the library and creates Catalog state.
- **Recursive_Discovery_System**: The part of the Icon_Import_System that traverses a selected directory and identifies Supported_Media_Files.
- **Catalog_Lifecycle_System**: The part of the Icon_Import_System that synchronizes Catalog_Records, Catalog_Cards, item states, and Catalog_Order.
- **Card_Interaction_System**: The part of the Icon_Import_System that handles user actions on Catalog_Cards.
- **Timeline_Insertion_System**: The part of the Icon_Import_System that issues Timeline_Import_Requests and creates Timeline_Layers.
- **Bulk_Import_System**: The part of the Icon_Import_System that coordinates one Bulk_Import.
- **Cleanup_System**: The part of the Icon_Import_System that removes Catalog state and Owned_Partial_Artifacts belonging to a Failed_Item.
- **Feedback_System**: The part of the Icon_Import_System that presents Picker_Import status and results to the user.

## Requirements

### Requirement 1: Catalog-First Picker Imports

**User Story:** As a catalog user, I want file and folder pickers to populate the catalog without modifying the timeline, so that timeline placement remains an explicit card action.

#### Acceptance Criteria

1. WHEN the File_Picker returns one Supported_Media_File, THE Catalog_Ingestion_System SHALL create one Import_Candidate for Picker_Import.
2. WHEN the Folder_Picker returns a directory, THE Recursive_Discovery_System SHALL inspect the selected directory and nested directories within Discovery_Limits.
3. WHEN the Recursive_Discovery_System finds a unique Supported_Media_File, THE Recursive_Discovery_System SHALL create one Import_Candidate for the Supported_Media_File.
4. WHEN the Recursive_Discovery_System encounters an Unsupported_File, THE Recursive_Discovery_System SHALL continue discovery without creating catalog state for the Unsupported_File.
5. WHEN multiple discovered paths resolve to one Source_Identity, THE Recursive_Discovery_System SHALL create exactly one Import_Candidate for the Source_Identity.
6. WHEN Picker_Import begins, THE Icon_Import_System SHALL preserve the existing layer set in the Active_Composition until a Normal_Card_Action occurs on a Ready_Card.
7. WHEN Picker_Import begins without an Active_Composition, THE Catalog_Ingestion_System SHALL continue catalog ingestion.
8. IF recursive discovery produces zero Import_Candidates, THEN THE Feedback_System SHALL report "No supported media found in folder".
9. IF recursive discovery produces zero Import_Candidates, THEN THE Catalog_Lifecycle_System SHALL preserve the Catalog without provisional records or cards from the Picker_Import.
10. IF the user cancels the File_Picker or Folder_Picker, THEN THE Icon_Import_System SHALL complete the Picker_Import as cancelled with no Catalog or Timeline changes.

### Requirement 2: Durability-Gated Card Readiness

**User Story:** As a catalog user, I want pending imports to be distinguishable from usable cards, so that an incomplete copy cannot trigger a misleading timeline error.

#### Acceptance Criteria

1. WHEN the Catalog_Ingestion_System accepts an Import_Candidate, THE Catalog_Lifecycle_System SHALL represent the Import_Candidate in Pending_State until the Durability_Gate is satisfied.
2. WHEN the Catalog_Lifecycle_System creates a Pending_Card, THE Catalog_Lifecycle_System SHALL display the source-derived Item_Name and Category_Name on the Pending_Card.
3. WHILE an Import_Candidate remains in Pending_State, THE Card_Interaction_System SHALL keep the Normal_Card_Action disabled for the Pending_Card.
4. WHILE an Import_Candidate remains in Pending_State, THE Card_Interaction_System SHALL issue zero Timeline_Import_Requests for the Pending_Card.
5. WHEN the user activates a Pending_Card, THE Feedback_System SHALL report that catalog import for the Item_Name is still in progress.
6. WHEN the user activates a Pending_Card, THE Feedback_System SHALL classify the outcome as Pending_State rather than as a missing Backing_Destination or Main_File.
7. WHEN an Import_Candidate satisfies the Durability_Gate, THE Catalog_Lifecycle_System SHALL transition the Catalog_Record and Catalog_Card to Ready_State exactly once.
8. WHEN a Catalog_Card enters Ready_State, THE Card_Interaction_System SHALL enable the Normal_Card_Action for the Ready_Card.
9. WHEN the Durability_Gate is satisfied before Thumbnail_Generation completes, THE Catalog_Lifecycle_System SHALL render the Placeholder_Visual for the Ready_Card.
10. WHEN the Durability_Gate is satisfied before Thumbnail_Generation completes, THE Card_Interaction_System SHALL keep the Normal_Card_Action enabled while Thumbnail_Generation continues.
11. WHEN the Catalog loads a Preexisting_Catalog_Record with an existing Backing_Destination and Main_File, THE Catalog_Lifecycle_System SHALL classify the Preexisting_Catalog_Record as Ready_State.
12. IF a Required_Durability_Stage fails, THEN THE Catalog_Lifecycle_System SHALL classify the affected Import_Candidate as a Failed_Item rather than a Successful_Item.

### Requirement 3: Ready Icon Placement in the Active Timeline

**User Story:** As an After Effects user, I want a ready icon card to place the icon in the active composition, so that catalog icons are usable without manual file browsing.

#### Acceptance Criteria

1. WHEN a Normal_Card_Action occurs on a Ready_Card and an Active_Composition exists, THE Timeline_Insertion_System SHALL issue exactly one Timeline_Import_Request for the selected Catalog_Record.
2. WHEN the Timeline_Insertion_System builds a Timeline_Import_Request, THE Timeline_Insertion_System SHALL identify the Backing_Destination with the selected Catalog_Record's Stored_Folder_Path.
3. WHEN the Timeline_Insertion_System builds a Timeline_Import_Request, THE Timeline_Insertion_System SHALL identify the imported media with the selected Catalog_Record's Main_File.
4. WHEN the Timeline_Insertion_System builds a Timeline_Import_Request, THE Timeline_Insertion_System SHALL use the Card_Derived_Section as the request section.
5. WHEN the Card_Derived_Section is `icon`, THE Timeline_Insertion_System SHALL import the Main_File as image media.
6. WHEN the host reports a successful Timeline_Import_Request, THE Timeline_Insertion_System SHALL create at least one Timeline_Layer in the Active_Composition for the selected Catalog_Record.
7. WHEN the Timeline_Layer is created, THE Timeline_Insertion_System SHALL make the Timeline_Layer source reference the selected Main_File.
8. WHEN Timeline_Layer creation succeeds, THE Feedback_System SHALL report successful icon placement.
9. IF no Active_Composition exists when a Normal_Card_Action occurs, THEN THE Feedback_System SHALL return an Actionable_Reason for the missing Active_Composition.
10. IF the Stored_Folder_Path does not resolve to an existing Backing_Destination at card-action time, THEN THE Feedback_System SHALL return an Actionable_Reason for the missing Backing_Destination.
11. IF the Main_File does not exist inside the Backing_Destination at card-action time, THEN THE Feedback_System SHALL return an Actionable_Reason for the missing Main_File.
12. IF a Timeline_Import_Request fails after the Durability_Gate remains satisfied, THEN THE Catalog_Lifecycle_System SHALL preserve the Ready_Card for a later retry.

### Requirement 4: Progressive Partial-Success Bulk Import

**User Story:** As a catalog user, I want valid folder items to remain imported when other items fail, so that one bad file does not discard successful work.

#### Acceptance Criteria

1. WHEN Bulk_Import begins, THE Bulk_Import_System SHALL track each Import_Candidate as an independent item operation.
2. WHEN one Import_Candidate satisfies the Durability_Gate, THE Catalog_Lifecycle_System SHALL transition the corresponding Catalog_Card to Ready_State without waiting for another Import_Candidate to settle.
3. WHEN one Import_Candidate becomes a Failed_Item, THE Bulk_Import_System SHALL preserve every Successful_Item from the same Bulk_Import.
4. WHEN one Import_Candidate becomes a Failed_Item, THE Bulk_Import_System SHALL continue processing unsettled Import_Candidates from the same Bulk_Import.
5. WHEN Bulk_Import settles, THE Bulk_Import_System SHALL assign exactly one terminal classification of Successful_Item or Failed_Item to every Import_Candidate.
6. WHEN Bulk_Import contains both Successful_Items and Failed_Items, THE Bulk_Import_System SHALL complete with Partial_Success_Status.
7. WHEN a Catalog_Card transitions from Pending_State to Ready_State, THE Catalog_Lifecycle_System SHALL preserve the Card_ID, Item_Name, Category_Name, and Stored_Folder_Path.
8. WHEN Catalog_Cards transition independently during Bulk_Import, THE Catalog_Lifecycle_System SHALL preserve the relative Catalog_Order of the surviving Catalog_Cards.
9. WHEN all Import_Candidates reach a terminal classification, THE Bulk_Import_System SHALL wait for required Failed_Item cleanup before producing the Bulk_Import_Summary.

### Requirement 5: Failed-Item Cleanup

**User Story:** As a catalog user, I want failed provisional items removed cleanly, so that blank cards, stale index entries, and unusable folders do not remain in the library.

#### Acceptance Criteria

1. IF a Required_Durability_Stage fails for an Import_Candidate, THEN THE Cleanup_System SHALL begin cleanup for the corresponding Failed_Item.
2. WHEN Failed_Item cleanup begins, THE Cleanup_System SHALL remove the corresponding Pending_Card from the Catalog.
3. WHEN Failed_Item cleanup begins, THE Cleanup_System SHALL remove the corresponding in-memory Catalog_Record.
4. WHEN Failed_Item cleanup begins, THE Cleanup_System SHALL remove the corresponding persisted Catalog_Record from the Catalog_Index.
5. WHEN Failed_Item cleanup finds Owned_Partial_Artifacts, THE Cleanup_System SHALL remove the Owned_Partial_Artifacts associated with the Failed_Item.
6. WHEN Failed_Item cleanup evaluates a filesystem path, THE Cleanup_System SHALL limit deletion to Owned_Partial_Artifacts uniquely associated with the Failed_Item.
7. WHEN Failed_Item cleanup runs more than once for the same Failed_Item, THE Cleanup_System SHALL produce the same final Catalog and filesystem state as one cleanup run.
8. WHEN Failed_Item cleanup completes, THE Catalog_Lifecycle_System SHALL contain zero Pending_Cards and zero Catalog_Records for the Failed_Item.
9. WHEN Failed_Item cleanup completes, THE Cleanup_System SHALL preserve Catalog_Records, Catalog_Cards, and files belonging to Successful_Items.
10. IF removal of an Owned_Partial_Artifact fails, THEN THE Cleanup_System SHALL record an Actionable_Reason for the incomplete cleanup.

### Requirement 6: Exact and Actionable Import Feedback

**User Story:** As a catalog user, I want folder-import results to identify successes and failures, so that I can keep valid icons and correct failed inputs.

#### Acceptance Criteria

1. WHEN Bulk_Import_Summary is produced, THE Feedback_System SHALL report the exact count of Successful_Items.
2. WHEN Bulk_Import_Summary is produced, THE Feedback_System SHALL report the exact count of Failed_Items.
3. WHEN Bulk_Import_Summary is produced, THE Feedback_System SHALL report counts whose sum equals the number of Import_Candidates.
4. WHEN Bulk_Import contains at least one Failed_Item, THE Feedback_System SHALL include one Actionable_Reason for each Failed_Item.
5. WHEN Bulk_Import contains both Successful_Items and Failed_Items, THE Feedback_System SHALL identify the result as completed with failures rather than as complete success or complete failure.
6. WHEN every Import_Candidate becomes a Successful_Item, THE Feedback_System SHALL identify the Bulk_Import as complete success.
7. WHEN every Import_Candidate becomes a Failed_Item, THE Feedback_System SHALL identify the Bulk_Import as complete failure.
8. IF Failed_Item cleanup remains incomplete, THEN THE Feedback_System SHALL include an Actionable_Reason for each remaining Owned_Partial_Artifact in the Bulk_Import_Summary.
9. IF an Operation_Level_Failure occurs, THEN THE Feedback_System SHALL report an Actionable_Reason for the Operation_Level_Failure.

### Requirement 7: Routing, Path, Ordering, and Lifecycle Regression Protection

**User Story:** As a catalog user, I want the fixes to preserve established catalog behavior, so that icon reliability does not regress ordering, paths, discovery, or media lifecycle performance.

#### Acceptance Criteria

1. WHEN the Catalog_Ingestion_System derives a destination path, THE Catalog_Ingestion_System SHALL apply Path_Sanitization exactly once to each Category_Name and Item_Name path segment.
2. WHEN Path_Sanitization receives an input covered by the Path_Sanitization_Baseline, THE Catalog_Ingestion_System SHALL produce byte-identical output to the Path_Sanitization_Baseline.
3. WHEN the Catalog_Lifecycle_System stores a Backing_Destination, THE Catalog_Lifecycle_System SHALL store the normalized Stored_Folder_Path used by the Main_File copy.
4. WHEN a Normal_Card_Action occurs, THE Timeline_Insertion_System SHALL preserve Card_Derived_Section routing independently of the currently visible catalog section.
5. WHEN an item transitions between Pending_State and Ready_State, THE Catalog_Lifecycle_System SHALL preserve the Catalog_Order position assigned at insertion.
6. WHEN Failed_Item cleanup removes a card, THE Catalog_Lifecycle_System SHALL preserve the relative Catalog_Order of all surviving cards.
7. WHEN one item reaches Ready_State or Failed_Item classification, THE Catalog_Lifecycle_System SHALL update the affected item without requiring a Full_Filesystem_Rescan.
8. WHEN Thumbnail_Generation succeeds after Ready_State, THE Catalog_Lifecycle_System SHALL update the existing Ready_Card without changing the Card_ID or Stored_Folder_Path.
9. WHEN Thumbnail_Generation fails after the Durability_Gate is satisfied, THE Catalog_Lifecycle_System SHALL preserve the Ready_Card with the Thumbnail_Failure_Visual.
10. WHEN Recursive_Discovery processes a folder hierarchy, THE Recursive_Discovery_System SHALL use the Supported_Media_File registry specified by the Discovery_Baseline.
11. WHEN Recursive_Discovery processes a folder hierarchy, THE Recursive_Discovery_System SHALL apply the Discovery_Limits specified by the Discovery_Baseline.
12. WHEN Recursive_Discovery processes a folder hierarchy, THE Recursive_Discovery_System SHALL apply the Source_Identity deduplication behavior specified by the Discovery_Baseline.
13. WHEN Bulk_Import contains Successful_Items, THE Bulk_Import_System SHALL preserve Successful_Item files without whole-folder rollback.
14. WHEN Bulk_Import contains Successful_Items, THE Bulk_Import_System SHALL preserve Successful_Item Catalog_Records without whole-folder rollback.
15. WHEN a Ready_Card is reopened from the persisted Catalog, THE Card_Interaction_System SHALL expose the same Normal_Card_Action available before panel closure.
