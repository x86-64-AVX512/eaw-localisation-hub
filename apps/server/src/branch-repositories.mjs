const EAW_REPOSITORY = /^(?:EaW-Team\/equestria_dev|https:\/\/github\.com\/EaW-Team\/equestria_dev(?:\.git)?\/?)$/iu;

// One approved external branch. Keep other branches on the configured canonical repository.
export function branchRepositoriesFor(repository) {
  return EAW_REPOSITORY.test(String(repository ?? '').trim())
    ? { barrad: 'MiszczTheMaste/equestria_dev' }
    : {};
}
