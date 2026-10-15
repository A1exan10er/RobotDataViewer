"""Repair an existing pre-release after complete-package verification, with backups."""
import argparse
import base64
import getpass
import http.client
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.parse
import urllib.request

from verify_release import digest, require, verify_staged

GITHUB_REPO = 'A1exan10er/RobotDataViewer'
GITEA_HOST = 'https://git.neoteai.com'
GITEA_REPO = 'yangtianyu/RobotDataViewer'


def retry(action):
    for attempt in range(3):
        try:
            return action()
        except (OSError, http.client.HTTPException, subprocess.CalledProcessError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)


class GitHub:
    def __init__(self, tag):
        self.tag = tag
        self.api = f'repos/{GITHUB_REPO}'

    def release(self):
        return json.loads(gh('api', f'{self.api}/releases/tags/{self.tag}'))

    def download(self, asset, destination):
        gh('release', 'download', self.tag, '--repo', GITHUB_REPO, '--pattern', asset['name'],
           '--dir', str(destination.parent), '--clobber')

    def upload(self, release, path):
        gh('release', 'upload', self.tag, str(path), '--repo', GITHUB_REPO, '--clobber')

    def notes(self, release, path):
        gh('release', 'edit', self.tag, '--repo', GITHUB_REPO, '--notes-file', str(path))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(request, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(request.full_url).netloc:
            redirected.remove_header('Authorization')
        return redirected


class Gitea:
    def __init__(self, tag, user=None, token_file=None):
        self.tag = tag
        self.api = f'/api/v1/repos/{GITEA_REPO}'
        token = Path(token_file).read_text().strip() if token_file else os.environ.get('GITEA_TOKEN')
        require(bool(token or user), 'Supply GITEA_TOKEN, --gitea-token-file or --gitea-user')
        self.authorization = 'token ' + token if token else 'Basic ' + base64.b64encode((user + ':' + getpass.getpass('Gitea password (not saved): ')).encode()).decode()
        self.opener = urllib.request.build_opener(SafeRedirect())

    def request(self, method, path, body=None):
        headers = {'Authorization': self.authorization, 'Accept': 'application/json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(GITEA_HOST + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        with self.opener.open(request, timeout=60) as response:
            data = response.read()
            return json.loads(data) if data else None

    def release(self):
        return self.request('GET', f'{self.api}/releases/tags/{self.tag}')

    def download(self, asset, destination):
        url = asset['browser_download_url']
        require(urllib.parse.urlsplit(url).netloc == urllib.parse.urlsplit(GITEA_HOST).netloc, 'Unexpected Gitea download host')
        request = urllib.request.Request(url, headers={'Authorization': self.authorization})
        partial = destination.with_name(destination.name + '.part')
        with self.opener.open(request, timeout=120) as response, partial.open('wb') as stream:
            while block := response.read(1024 * 1024):
                stream.write(block)
        partial.replace(destination)

    def upload(self, release, path):
        # Refresh on retries: a previous attempt may have created a partial asset.
        current = self.release()
        for asset in current['assets']:
            if asset['name'] == path.name:
                self.request('DELETE', f'{self.api}/releases/{release["id"]}/assets/{asset["id"]}')
        boundary = 'rdv-' + secrets.token_hex(16)
        prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
        suffix = f'\r\n--{boundary}--\r\n'.encode()
        def chunks():
            yield prefix
            with path.open('rb') as stream:
                while block := stream.read(1024 * 1024):
                    yield block
            yield suffix
        connection = http.client.HTTPSConnection(urllib.parse.urlsplit(GITEA_HOST).netloc, timeout=180)
        try:
            connection.request('POST', f'{self.api}/releases/{release["id"]}/assets?name={urllib.parse.quote(path.name)}', body=chunks(), headers={
                'Authorization': self.authorization, 'Content-Type': f'multipart/form-data; boundary={boundary}',
                'Content-Length': str(len(prefix) + path.stat().st_size + len(suffix)),
            })
            response = connection.getresponse(); response.read()
            if response.status != 201:
                raise OSError(f'Gitea asset upload returned HTTP {response.status}')
        finally:
            connection.close()

    def notes(self, release, path):
        self.request('PATCH', f'{self.api}/releases/{release["id"]}', {'body': path.read_text()})


def publish(client, directory, backup, notes):
    manifest = verify_staged(directory)
    release = retry(client.release)
    require(release['prerelease'] and not release['draft'], 'Only repair the existing published pre-release')
    require(release['tag_name'] == 'v' + manifest['version'], 'Release tag differs from packages')
    names = [asset['name'] for asset in manifest['assets']] + ['RELEASE-MANIFEST.json', 'SHA256SUMS.txt']
    backup.mkdir(parents=True, exist_ok=False)
    (backup / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
    old = {asset['name']: asset for asset in release['assets']}
    for name in names:
        if name in old:
            print('Backing up', name, flush=True)
            retry(lambda: client.download(old[name], backup / name))
            expected = old[name].get('size')
            require(expected is None or (backup / name).stat().st_size == expected, f'{name}: incomplete backup')
            remote_digest = old[name].get('digest', '') or ''
            if remote_digest.startswith('sha256:'):
                require(digest(backup / name) == remote_digest[7:], f'{name}: backup checksum differs')
    downloaded = backup / 'verified-downloads'; downloaded.mkdir()
    changed = []
    try:
        for name in names:
            path = directory / name
            if name not in old or digest(backup / name) != digest(path):
                changed.append(name)
                print('Uploading', name, flush=True)
                retry(lambda: client.upload(release, path))
            current = retry(client.release)
            matches = [asset for asset in current['assets'] if asset['name'] == name]
            require(len(matches) == 1, f'{name}: uploaded asset is absent or duplicated')
            print('Downloading and verifying', name, flush=True)
            retry(lambda: client.download(matches[0], downloaded / name))
            require(digest(downloaded / name) == digest(path), f'{name}: published checksum differs')
        verify_staged(downloaded)
        retry(lambda: client.notes(release, notes))
        require(retry(client.release)['body'].replace('\r\n', '\n') == notes.read_text().replace('\r\n', '\n'), 'Release notes did not persist')
        result = {'published': True, 'url': release['html_url'], 'version': manifest['version'], 'commit': manifest['commit'], 'assets': manifest['assets']}
        (backup / 'publication.json').write_text(json.dumps(result, indent=2) + '\n')
        return result
    except Exception:
        # Restore replaced assets. New, additive assets may remain; no success is claimed.
        for name in changed:
            if name in old:
                print('Restoring previous asset', name, flush=True)
                try:
                    retry(lambda: client.upload(release, backup / name))
                except Exception as error:
                    print(f'Restore failed for {name}: {type(error).__name__}; backup retained at {backup / name}', flush=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=('github', 'gitea'), required=True)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--notes', type=Path)
    parser.add_argument('--gitea-user')
    parser.add_argument('--gitea-token-file', type=Path)
    parser.add_argument('--inspect', action='store_true')
    args = parser.parse_args()
    if not args.inspect and not all((args.directory, args.backup, args.notes)):
        parser.error('Publishing requires --directory, --backup and --notes')
    if not args.inspect:
        verify_staged(args.directory)  # Validate before requesting credentials or mutating a host.
    client = GitHub('v1.5.0-rc.3') if args.host == 'github' else Gitea('v1.5.0-rc.3', args.gitea_user, args.gitea_token_file)
    if args.inspect:
        release = retry(client.release)
        print(json.dumps({k: release[k] for k in ('id', 'tag_name', 'html_url', 'draft', 'prerelease')}))
        print(json.dumps([{'name': a['name'], 'bytes': a['size']} for a in release['assets']]))
    else:
        print(json.dumps(publish(client, args.directory, args.backup, args.notes), indent=2))
