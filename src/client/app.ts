import '../index.css';
import { parseAppRoute } from '../appUtils';
import { setHidden } from './dom';

const route = parseAppRoute();
const browseShell = document.getElementById('browse-shell');
const editShell = document.getElementById('edit-shell');

if (route.mode === 'edit') {
  if (browseShell) setHidden(browseShell, true);
  if (editShell) setHidden(editShell, false);
  void import('./edit').then(({ initEdit }) => initEdit(route.id));
} else {
  if (browseShell) setHidden(browseShell, false);
  if (editShell) setHidden(editShell, true);
  void Promise.all([import('./browse'), import('./liveBand')]).then(([{ initBrowse }, { createLiveBand }]) => {
    const liveBand = createLiveBand();
    void initBrowse(liveBand);
  });
}
