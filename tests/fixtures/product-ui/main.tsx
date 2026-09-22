// Product-owned composition: the independent design viewer never imports this entry.
import { mountViewer } from "../design-system/viewer";
import { ComposerSpecimens } from "../../../src/bundled/composer/lab/ComposerSpecimens";
import "./styles.css";
mountViewer(ComposerSpecimens);
