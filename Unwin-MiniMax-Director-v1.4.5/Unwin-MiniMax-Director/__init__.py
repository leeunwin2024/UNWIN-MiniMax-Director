import logging
LOG = logging.getLogger('unwin.director')
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
WEB_DIRECTORY = './web'
for _module in ('ai_upscale', 'studio'):
    try:
        __import__(f'{__package__}.{_module}', fromlist=[_module])
    except (ImportError, OSError) as exc:
        LOG.warning('Optional UNWIN component %s unavailable: %s', _module, exc)
