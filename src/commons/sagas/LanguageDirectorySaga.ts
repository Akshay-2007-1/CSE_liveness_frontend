import type { ILanguageDefinition } from '@sourceacademy/language-directory/dist/types';
import { getEvaluatorDefinition } from '@sourceacademy/language-directory/dist/util';
import { Chapter, Variant } from 'js-slang/dist/langs';
import { call, fork, put, select } from 'redux-saga/effects';
import { selectConductorEnable } from 'src/features/conductor/flagConductorEnable';
import { selectDirectoryLanguageUrl } from 'src/features/directory/flagDirectoryLanguageUrl';

import LanguageDirectoryActions from '../../features/directory/LanguageDirectoryActions';
import type { LanguageDirectoryState } from '../../features/directory/LanguageDirectoryTypes';
import type { OverallState } from '../application/ApplicationTypes';
import { combineSagaHandlers } from '../redux/utils';
import WorkspaceActions from '../workspace/WorkspaceActions';
import { preloadConductorEvaluatorSaga } from './helpers/conductorEvaluatorCache';

export function* getLanguageDefinitionSaga() {
  const directory: LanguageDirectoryState = yield select(
    (state: OverallState) => state.languageDirectory,
  );
  if (!directory.selectedLanguageId) return undefined;
  return directory.languageMap[directory.selectedLanguageId];
}

export function* getEvaluatorDefinitionSaga() {
  const directory: LanguageDirectoryState = yield select(
    (state: OverallState) => state.languageDirectory,
  );
  if (!directory.selectedEvaluatorId) return undefined;
  const language: ILanguageDefinition = yield call(getLanguageDefinitionSaga);
  if (!language) return undefined;
  return getEvaluatorDefinition(language, directory.selectedEvaluatorId);
}

const languageDirectoryHandlers = combineSagaHandlers({
  [LanguageDirectoryActions.setLanguages.type]: function* () {
    const directory = yield select((state: OverallState) => state.languageDirectory);
    if (directory.languages.length > 0) {
      yield put(LanguageDirectoryActions.setSelectedLanguage(directory.languages[0].id));
    }
  },
  [LanguageDirectoryActions.fetchLanguages.type]: function* () {
    const url = yield select(selectDirectoryLanguageUrl);
    const response = yield call(fetch, url);
    if (!response.ok) {
      throw new Error(`Can't retrieve language directory: ${response.status}`);
    }
    const result: ILanguageDefinition[] = yield call([response, 'json']);
    yield put(LanguageDirectoryActions.setLanguages(result));
  },
  [LanguageDirectoryActions.setSelectedLanguage.type]: function* () {
    const language = yield call(getLanguageDefinitionSaga);
    if (!language) return;
    if (language.evaluators.length > 0) {
      yield put(LanguageDirectoryActions.setSelectedEvaluator(language.evaluators[0].id));
    }

    // Clear stale CSE snapshots so the tab doesn't show for languages/chapters that don't support it
    yield put(WorkspaceActions.updateCseSnapshots(null, 'playground'));

    // If the workspace chapter is FULL_JAVA, reset it to Source 4 so that conductor languages
    // (e.g. Python) don't accidentally run in Java mode — isJava() checks this chapter.
    const currentChapter: Chapter = yield select(
      (state: OverallState) => state.workspaces.playground.context.chapter,
    );
    if (currentChapter === Chapter.FULL_JAVA) {
      yield put(WorkspaceActions.chapterSelect(Chapter.SOURCE_4, Variant.DEFAULT, 'playground'));
    }

    const conductorEnabled: boolean = yield select(selectConductorEnable);
    if (!conductorEnabled) return;

    const evaluator = yield call(getEvaluatorDefinitionSaga);
    if (!evaluator?.path) return;

    try {
      yield call(preloadConductorEvaluatorSaga, evaluator.path);
    } catch (error) {
      console.error('Failed to preload:', error);
    }
  },
});

function* LanguageDirectorySaga() {
  yield fork(languageDirectoryHandlers);
  yield put(LanguageDirectoryActions.fetchLanguages());
}

export default LanguageDirectorySaga;
